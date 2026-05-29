const transporter = require('../utils/mail');
const pool = require('../utils/db');
const { log } = require('../utils/logger/logger');
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

function parseProposal(proposal) {
  try {
    const cleaned = proposal.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return parsed.proposal || proposal;
  } catch {
    return proposal;
  }
}

function parseEmails(emailsJson) {
  try {
    const data = typeof emailsJson === 'string' ? JSON.parse(emailsJson) : emailsJson;
    return (data.emails || []).filter(e =>
      e.includes('@') &&
      !e.match(/\.(png|jpg|jpeg|webp|gif|svg|avif)$/i)
    );
  } catch {
    return [];
  }
}

async function run() {
  log('INFO', 'Starting email sender...');
  let jobs;

  try {
    const results = await pool.execute(`
      SELECT job_id, title, emails, proposal, email_subject, contact_name
      FROM jobs
      WHERE status = 'emails_found'
        AND emails IS NOT NULL
        AND proposal IS NOT NULL
      LIMIT 10
    `);
    jobs = results[0];
    log('INFO', `Jobs to send: ${jobs.length}`);
  } catch (err) {
    log('ERROR', `DB fetch error: ${err.message}`);
    process.exit(1);
  }

  for (const job of jobs) {
    const emailAddresses = parseEmails(job.emails);
    const proposalText = parseProposal(job.proposal);

    if (emailAddresses.length === 0) {
      log('INFO', `No valid emails for job ${job.job_id} — skipping`);
      await pool.execute(
        `UPDATE jobs SET status = 'failed', error = 'no valid emails found' WHERE job_id = ?`,
        [job.job_id]
      );
      continue;
    }

    const greeting = job.contact_name && job.contact_name !== 'null'
      ? `Hi ${job.contact_name},\n\n`
      : '';

    const subject = job.email_subject || `Quick note on your project — ${job.title}`;
    const emailBody = greeting + proposalText;

    try {
      for (const email of emailAddresses) {
        await transporter.sendMail({
          from: process.env.BREVO_FROM,
          to: email,
          subject: subject,
          text: emailBody,
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

process.on('SIGINT', async () => {
  log('INFO', 'Gracefully shutting down...');
  await pool.end();
  process.exit(0);
});

run();