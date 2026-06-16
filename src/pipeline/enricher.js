const pool = require('../utils/db');
const Groq = require('groq-sdk');
const { log } = require('../utils/logger/logger');
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');

// load prompt once at startup
const promptTemplate = fs.readFileSync(
  path.join(__dirname, '../../prompts/enrich.prompt.txt'),
  'utf8'
);

if (!process.env.GROQ_API_KEY) throw new Error('Missing GROQ_API_KEY');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Helper to clean and normalise URLs
function cleanUrl(url) {
  if (!url || url === 'null') return null;
  // Remove markdown links [text](url)
  const markdown = url.match(/\[.*?\]\((https?:\/\/[^\)]+)\)/);
  if (markdown) return markdown[1];
  // Ensure protocol
  return url.startsWith('http') ? url : `https://${url}`;
}

// Extract any direct email address from the job description
function extractDirectEmail(description) {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
  const match = description.match(emailRegex);
  return match ? match[0] : null;
}

async function enrich(job, attempt = 1) {

  const prompt = promptTemplate
  .replace('{{title}}', job.title)
  .replace('{{description}}', job.description.slice(0, 1500));


  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{
        role: "user",
        content: prompt
      }],
      max_tokens: 1200,
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

    // Validate proposal
    if (!parsed.proposal || parsed.proposal.length < 40) {
      log('ERROR', `Proposal too short or missing for job ${job.job_id}`);
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, attempt * 2000));
        return enrich(job, attempt + 1);
      }
      return null;
    }

    // Extract direct email from description (if any)
    const directEmail = extractDirectEmail(job.description);
    let emailsArray = [];
    if (directEmail) {
      emailsArray = [directEmail];
      log('INFO', `Found direct email in description: ${directEmail}`);
    }

    // Final result
    return {
      website: cleanUrl(parsed.website),
      company_name: parsed.company_name && parsed.company_name !== 'null' ? parsed.company_name : null,
      contact_name: parsed.contact_name && parsed.contact_name !== 'null' ? parsed.contact_name : null,
      subject: parsed.subject || `Quick note on your project — ${job.title}`,
      proposal: parsed.proposal,
      emails: emailsArray,  // store any direct email
    };

  } catch (err) {
    log('ERROR', `Groq error on job ${job.job_id}: ${err.message}`);
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, attempt * 3000));
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

    await pool.execute(
      `UPDATE jobs SET status = 'enriching' WHERE job_id = ?`,
      [job.job_id]
    );

    const result = await enrich(job);

    if (result) {
      // Prepare emails JSON column
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
          job.job_id
        ]
      );
      log('INFO', `Enriched: ${job.title} | website: ${result.website} | company: ${result.company_name} | email: ${result.emails[0] || 'none'}`);
    } else {
      await pool.execute(
        `UPDATE jobs SET
          status = 'failed',
          error = 'Groq enrichment failed after 3 attempts'
        WHERE job_id = ?`,
        [job.job_id]
      );
      log('ERROR', `Failed to enrich job ${job.job_id}`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  log('INFO', 'Enricher done.');
  await pool.end();
}

let isShuttingDown = false;

process.on('SIGINT', async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log('INFO', 'Gracefully shutting down...');
  await pool.end();
  process.exit(0);
});

main();