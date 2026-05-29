const pool = require('../utils/db');
const Groq = require('groq-sdk');
const { log } = require('../utils/logger/logger');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

if (!process.env.GROQ_API_KEY) throw new Error('Missing GROQ_API_KEY');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Load prompt template from external file
const PROMPT_TEMPLATE = fs.readFileSync(
  path.join(__dirname, '../../prompts/enricher-prompt.txt'),
  'utf8'
);

function cleanUrl(url) {
  if (!url || url === 'null') return null;
  const markdown = url.match(/\[.*?\]\((https?:\/\/[^\)]+)\)/);
  if (markdown) return markdown[1];
  return url.startsWith('http') ? url : `https://${url}`;
}

function extractDirectEmail(description) {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
  const match = description.match(emailRegex);
  return match ? match[0] : null;
}

async function enrich(job, attempt = 1) {
  // Inject job data into prompt template
  const prompt = PROMPT_TEMPLATE
    .replace('{{title}}', job.title)
    .replace('{{description}}', job.description.slice(0, 2000));

  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1100,
      temperature: 0.7,
    });

    const raw = response.choices[0].message.content.trim();
    let parsed;

    try {
      const cleaned = raw.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (err) {
      log('ERROR', `JSON parse failed for job ${job.job_id}: ${raw.slice(0, 100)}`);
      if (attempt < 3) {
        const wait = attempt * 2000;
        log('INFO', `Retrying in ${wait / 1000}s... (attempt ${attempt})`);
        await new Promise(r => setTimeout(r, wait));
        return enrich(job, attempt + 1);
      }
      return null;
    }

    if (!parsed.proposal || parsed.proposal.length < 100) {
      log('ERROR', `Proposal too short for job ${job.job_id}`);
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, attempt * 2000));
        return enrich(job, attempt + 1);
      }
      return null;
    }

    const directEmail = extractDirectEmail(job.description);
    let emailsArray = directEmail ? [directEmail] : [];

    return {
      website: cleanUrl(parsed.website),
      company_name: parsed.company_name && parsed.company_name !== 'null' ? parsed.company_name : null,
      contact_name: parsed.contact_name && parsed.contact_name !== 'null' ? parsed.contact_name : null,
      subject: parsed.subject || `Quick note on your project — ${job.title}`,
      proposal: parsed.proposal,
      emails: emailsArray,
    };

  } catch (err) {
    log('ERROR', `Groq error on job ${job.job_id}: ${err.message}`);
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, attempt * 2000));
      return enrich(job, attempt + 1);
    }
    return null;
  }
}

async function main() {
  log('INFO', 'Starting enricher...');
  let jobs;

  try {
    const results = await pool.execute(`
      SELECT job_id, title, description
      FROM jobs
      WHERE (
        status = 'scraped'
        OR status IS NULL
        OR (status = 'enriching' AND updated_at < NOW() - INTERVAL 10 MINUTE)
      )
      AND description IS NOT NULL
      LIMIT 10
    `);
    jobs = results[0];
    log('INFO', `Jobs to enrich: ${jobs.length}`);
  } catch (err) {
    log('ERROR', `DB fetch error: ${err.message}`);
    process.exit(1);
  }

  for (const job of jobs) {
    log('INFO', `Processing: ${job.title}`);
    await pool.execute(`UPDATE jobs SET status = 'enriching' WHERE job_id = ?`, [job.job_id]);

    const result = await enrich(job);

    if (result) {
      const emailsJson = JSON.stringify({ emails: result.emails });
      await pool.execute(
        `UPDATE jobs SET
          company_website = ?,
          company_name = ?,
          contact_name = ?,
          email_subject = ?,
          proposal = ?,
          emails = ?,
          proposal_generated_at = NOW(),
          status = 'enriched',
          error = NULL
        WHERE job_id = ?`,
        [
          result.website,
          result.company_name,
          result.contact_name,
          result.subject,
          result.proposal,
          emailsJson,
          job.job_id,
        ]
      );
      log('INFO', `Enriched: ${job.title} | website: ${result.website} | company: ${result.company_name} | email: ${result.emails[0] || 'none'}`);
    } else {
      await pool.execute(
        `UPDATE jobs SET status = 'failed', error = 'Groq enrichment failed after 3 attempts' WHERE job_id = ?`,
        [job.job_id]
      );
      log('ERROR', `Failed to enrich job ${job.job_id}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  log('INFO', 'Enricher done.');
  await pool.end();
}

process.on('SIGINT', async () => {
  log('INFO', 'Gracefully shutting down...');
  await pool.end();
  process.exit(0);
});

main();