const pool = require('../utils/db');
const Groq = require('groq-sdk');
const { log } = require('../utils/logger/logger');
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

if (!process.env.GROQ_API_KEY) throw new Error('Missing GROQ_API_KEY');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

function cleanUrl(url) {
  if (!url || url === 'null') return null;
  const markdown = url.match(/\[.*?\]\((https?:\/\/[^\)]+)\)/);
  if (markdown) return markdown[1];
  return url.startsWith('http') ? url : `https://${url}`;
}

async function enrich(job, attempt = 1) {
  try {

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{
        role: "user",
        content: `You are an AI orchestration engine inside a production-grade lead generation system.

Your job:
1. Understand the client deeply
2. Extract structured business intelligence
3. Generate personalized outreach that converts
4. Return ONLY valid JSON with no markdown or backticks

Think like a senior freelance consultant, technical architect, and sales strategist. Never sound robotic, desperate, or AI-generated.

━━━━━━━━━━━━━━━━━━
ABOUT ME
━━━━━━━━━━━━━━━━━━
Full-stack developer experienced in: React, Next.js, TypeScript, Node.js, PostgreSQL, WordPress, Shopify, WooCommerce, Tailwind CSS, Webflow, AI integrations, scalable backend systems.

I build: SaaS apps, dashboards, internal tools, e-commerce systems, AI-powered products, workflow automation, scalable APIs, conversion-focused websites.

Tone: concise, sharp, human, confident, calm, strategic.
Never overhype, sound needy, use buzzwords, or sound like a generic freelancer.

━━━━━━━━━━━━━━━━━━
YOUR TASK
━━━━━━━━━━━━━━━━━━
Analyze the job post deeply. Understand:
- what the client ACTUALLY wants
- the real business problem
- technical complexity
- client sophistication level
- whether this is worth pursuing

Then generate:

{
  "website": "company website URL or null (extract from description)",
  "company_name": "company name or null",
  "contact_name": "client's first name if explicitly mentioned, else null",
  "subject": "short personalized subject line under 10 words",
  "proposal": "follow the blueprint below"
}

━━━━━━━━━━━━━━━━━━
PROPOSAL BLUEPRINT (follow exactly)
━━━━━━━━━━━━━━━━━━
Line 1: Start with a specific insight about THEIR project – e.g., "Noticed you need [specific requirement] –"
Line 2: Connect to a relevant past project (use my experience, don't invent metrics)
Line 3: Offer a strategic observation or potential challenge
Line 4: End with a clear, low-friction call to action (e.g., "If you're free Thursday, I can show a live demo.")

RULES:
- Never use greetings like "Hi", "I hope", "I'd love", "excited"
- Never list generic skills (React, WordPress, etc.) – assume they read my profile
- Keep under 150 words
- Sound like an intelligent, experienced peer, not a salesperson

━━━━━━━━━━━━━━━━━━
EXTRACTION RULES
━━━━━━━━━━━━━━━━━━
- Website: if company name, product, or brand is mentioned, infer the likely URL. Return null if uncertain.
- Company name: extract if clearly stated.
- Contact name: only if a first name appears (e.g., "Hi, I'm John"). Never invent.
- Subject: short, direct, personalized to the project.

━━━━━━━━━━━━━━━━━━
JOB TITLE: ${job.title}
JOB DESCRIPTION: ${job.description.slice(0, 1500)}`
      }],
      max_tokens: 800,
      temperature: 0.4,   // lower temperature for more deterministic output
    });

    const raw = response.choices[0].message.content.trim();

    let parsed;
    try {
      const cleaned = raw.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      log('ERROR', `JSON parse failed for job ${job.job_id}: ${raw.slice(0, 100)}`);
      if (attempt < 3) {
        const wait = attempt * 2000;
        log('INFO', `Retrying in ${wait / 1000}s... (attempt ${attempt})`);
        await new Promise(r => setTimeout(r, wait));
        return enrich(job, attempt + 1);
      }
      return null;
    }

    if (!parsed.proposal || parsed.proposal.length < 50) {
      log('ERROR', `Proposal too short or missing for job ${job.job_id}`);
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, attempt * 2000));
        return enrich(job, attempt + 1);
      }
      return null;
    }

    return {
      website: cleanUrl(parsed.website),
      company_name: parsed.company_name && parsed.company_name !== 'null' ? parsed.company_name : null,
      contact_name: parsed.contact_name && parsed.contact_name !== 'null' ? parsed.contact_name : null,
      subject: parsed.subject || `Quick note on your project — ${job.title}`,
      proposal: parsed.proposal,
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

    await pool.execute(
      `UPDATE jobs SET status = 'enriching' WHERE job_id = ?`,
      [job.job_id]
    );

    const result = await enrich(job);

    if (result) {
      await pool.execute(
        `UPDATE jobs SET
          company_website = ?,
          company_name = ?,
          contact_name = ?,
          email_subject = ?,
          proposal = ?,
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
          job.job_id
        ]
      );
      log('INFO', `Enriched: ${job.title} | website: ${result.website} | company: ${result.company_name}`);
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

process.on('SIGINT', async () => {
  log('INFO', 'Gracefully shutting down...');
  await pool.end();
  process.exit(0);
});

main();