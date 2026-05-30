const transporter = require('../utils/mail');
const pool = require('../utils/db');
const { log } = require('../utils/logger/logger');
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });


if (!process.env.BREVO_FROM) {
  log('ERROR', 'Missing BREVO_FROM in .env');
  process.exit(1);
}


function cleanProposal(rawProposal) {
  if (!rawProposal) return '';

  // Remove markdown code blocks (```json ... ``` or just ``` ... ```)
  let cleaned = rawProposal
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  // If it looks like a JSON object with a "proposal" field, extract it
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed.proposal && typeof parsed.proposal === 'string') {
      cleaned = parsed.proposal.trim();
    }
  } catch {
    // Not JSON – leave as is
  }

  // Remove any remaining markdown artifacts
  cleaned = cleaned
    .replace(/^proposal:\s*/i, '')
    .replace(/^"|"$/g, '')
    .trim();

  return cleaned;
}

/**
 * Extract email addresses from the emails JSON column
 * Expected format: { "emails": ["a@b.com"], ... } or just an array
 */
function parseEmails(emailsJson) {
  try {
    const data = typeof emailsJson === 'string' ? JSON.parse(emailsJson) : emailsJson;
    let emails = [];
    if (Array.isArray(data)) {
      emails = data;
    } else if (data && Array.isArray(data.emails)) {
      emails = data.emails;
    }
    // Basic validation
    return emails.filter(e => 
      e && typeof e === 'string' && 
      e.includes('@') && 
      !e.match(/\.(png|jpg|jpeg|webp|gif|svg|avif)$/i)
    );
  } catch (err) {
    log('ERROR', `Failed to parse emails JSON: ${err.message}`);
    return [];
  }
}

/**
 * Build a personalised greeting based on available data
 * Avoids adding a greeting if the proposal already starts with one
 */
function buildGreeting(contactName, companyName, existingProposal) {
  // If proposal already starts with "Hi", "Hello", "Dear", or similar, skip adding greeting
  const trimmedProposal = existingProposal ? existingProposal.trim() : '';
  if (/^(hi|hello|dear|hey|greetings)/i.test(trimmedProposal)) {
    return '';
  }

  if (contactName && contactName !== 'null' && contactName.trim().length > 0) {
    return `Hi ${contactName.trim()},\n\n`;
  }
  if (companyName && companyName !== 'null' && companyName.trim().length > 0) {
    return `Hello ${companyName.trim()},\n\n`;
  }
  return `Hello,\n\n`;
}

async function run() {
  log('INFO', '=== EMAIL SENDER STARTED ===');
  let jobs;

  try {
    const [rows] = await pool.execute(`
      SELECT job_id, title, emails, proposal, email_subject, contact_name, company_name
      FROM jobs
      WHERE status = 'emails_found'
        AND emails IS NOT NULL
        AND proposal IS NOT NULL
      LIMIT 10
    `);
    jobs = rows;
    log('INFO', `Jobs to send: ${jobs.length}`);
  } catch (err) {
    log('ERROR', `DB fetch error: ${err.message}`);
    process.exit(1);
  }

  for (const job of jobs) {
    const emailAddresses = parseEmails(job.emails);
    let rawProposal = job.proposal;
    let proposalText = cleanProposal(rawProposal);

    if (!proposalText) {
      log('ERROR', `Empty proposal for job ${job.job_id} – skipping`);
      await pool.execute(
        `UPDATE jobs SET status = 'failed', error = 'Empty proposal' WHERE job_id = ?`,
        [job.job_id]
      );
      continue;
    }

    if (emailAddresses.length === 0) {
      log('INFO', `No valid emails for job ${job.job_id} – marking as failed`);
      await pool.execute(
        `UPDATE jobs SET status = 'failed', error = 'No valid emails found' WHERE job_id = ?`,
        [job.job_id]
      );
      continue;
    }

    // Build greeting only if not already present in proposal
    const greeting = buildGreeting(job.contact_name, job.company_name, proposalText);
    const finalEmailBody = greeting + proposalText;

    const subject = job.email_subject || `Quick note on your project — ${job.title}`;

    log('INFO', `Preview for job ${job.job_id}:\nSubject: ${subject}\nBody preview: ${finalEmailBody.slice(0, 200)}...`);

    try {
      // Send to each email address with a small delay between recipients
      for (const email of emailAddresses) {
        await transporter.sendMail({
          from: process.env.BREVO_FROM,
          to: email,
          subject: subject,
          text: finalEmailBody,
        });
        log('INFO', `Sent to ${email} for job ${job.job_id}`);
        await new Promise(r => setTimeout(r, 1000));
      }

      await pool.execute(
        `UPDATE jobs SET status = 'sent', email_sent_at = NOW() WHERE job_id = ?`,
        [job.job_id]
      );

    } catch (err) {
      log('ERROR', `Failed to send for job ${job.job_id}: ${err.message}`);
      await pool.execute(
        `UPDATE jobs SET status = 'failed', error = ? WHERE job_id = ?`,
        [err.message, job.job_id]
      );
    }

    await new Promise(r => setTimeout(r, 500));
  }

  log('INFO', 'Email sender done. Closing pool.');
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

run();