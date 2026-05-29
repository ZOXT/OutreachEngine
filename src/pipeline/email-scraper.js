const pool = require('../utils/db');
const axios = require("axios");
const cheerio = require("cheerio");
const Groq = require('groq-sdk');
const { log } = require('../utils/logger/logger');
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const OBFUSCATED_REGEX = /([a-zA-Z0-9._%+\-]+)\s*[\[\(]at[\]\)]\s*([a-zA-Z0-9.\-]+)\s*[\[\(]dot[\]\)]\s*([a-zA-Z]{2,})/gi;
const SOCIAL_PATTERNS = {
  linkedin: /linkedin\.com\/company\/[a-zA-Z0-9\-\_]+/i,
  twitter: /twitter\.com\/[a-zA-Z0-9_]+|x\.com\/[a-zA-Z0-9_]+/i,
  instagram: /instagram\.com\/[a-zA-Z0-9_.]+/i,
  facebook: /facebook\.com\/[a-zA-Z0-9_.]+/i,
};

const SKIP_EMAILS = [
  "example@", "test@", "email@", "user@", "name@",
  "your@", "info@example", "noreply@", "no-reply@",
  "sentry", "wixpress.com"
];

async function fetchHTML(url) {
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      maxRedirects: 3,
    });
    return res.data;
  } catch {
    return null;
  }
}

function extractEmails(html) {
  const emails = new Set();
  const normal = html.match(EMAIL_REGEX) || [];
  normal.forEach(e => emails.add(e.toLowerCase()));
  const obfuscated = [...html.matchAll(OBFUSCATED_REGEX)];
  obfuscated.forEach(m => emails.add(`${m[1]}@${m[2]}.${m[3]}`.toLowerCase()));
  return [...emails].filter(e =>
    !SKIP_EMAILS.some(skip => e.includes(skip)) &&
    e.includes('@') &&
    !e.match(/\.(png|jpg|jpeg|webp|gif|svg|avif)$/i)
  );
}

function extractSocials(html) {
  const socials = {};
  for (const [platform, regex] of Object.entries(SOCIAL_PATTERNS)) {
    const match = html.match(regex);
    if (match) socials[platform] = `https://${match[0]}`;
  }
  return socials;
}

function cleanHtmlToText(html, maxLength = 3000) {
  if (!html) return '';
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, maxLength);
}

function getPageUrls(baseUrl) {
  const base = baseUrl.replace(/\/$/, "");
  return [
    base,
    `${base}/contact`,
    `${base}/contact-us`,
    `${base}/about`,
    `${base}/about-us`,
  ];
}

async function extractContactNameWithAI(combinedText) {
  if (!combinedText || combinedText.length < 200) return null;
  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        { 
          role: "system", 
          content: "You are a name extractor. Reply with ONLY a single first name (e.g., 'John') or the word 'null'. Never add any other words, punctuation, or explanation." 
        },
        { 
          role: "user", 
          content: `Extract the first name of the founder, CEO, owner, or main contact person from this company website text (homepage, about, contact pages combined).\n\n${combinedText.slice(0, 8000)}` 
        }
      ],
      max_tokens: 10,
      temperature: 0,
    });
    let name = response.choices[0].message.content.trim();
    name = name.replace(/[^a-zA-Z]/g, '');
    if (name && name.toLowerCase() !== "null" && name.length >= 2) {
      return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
    }
    return null;
  } catch (err) {
    log('ERROR', `AI name extraction error: ${err.message}`);
    return null;
  }
}

async function scrapeWebsite(website) {
  const urls = getPageUrls(website);
  const allEmails = new Set();
  let allSocials = {};
  let combinedText = "";

  for (const url of urls) {
    const html = await fetchHTML(url);
    if (!html) continue;

    const emails = extractEmails(html);
    emails.forEach(e => allEmails.add(e));

    const socials = extractSocials(html);
    allSocials = { ...allSocials, ...socials };

    const cleanText = cleanHtmlToText(html, 3000);
    combinedText += "\n" + cleanText;

    await new Promise(r => setTimeout(r, 300));
  }

  let contactName = null;
  if (combinedText.length > 500) {
    log('INFO', 'Attempting AI name extraction...');
    contactName = await extractContactNameWithAI(combinedText);
    if (contactName) log('INFO', `AI extracted name: ${contactName}`);
    else log('INFO', 'No name found by AI');
  }

  return {
    emails: [...allEmails],
    contact_name: contactName,
    ...allSocials,
  };
}

async function run() {
  log('INFO', 'Starting email scraper...');

  try {
    const results = await pool.execute(`
      SELECT job_id, title, company_website
      FROM jobs
      WHERE status = 'enriched'
        AND company_website IS NOT NULL
      LIMIT 10
    `);

    const jobs = results[0];
    log('INFO', `Jobs to scrape: ${jobs.length}`);

    for (const job of jobs) {
      log('INFO', `Scraping: ${job.title} | ${job.company_website}`);

      try {
        const data = await scrapeWebsite(job.company_website);

        log('INFO', `Emails found: ${data.emails.length > 0 ? data.emails.join(", ") : "none"}`);
        log('INFO', `Contact name: ${data.contact_name || "none"}`);
        log('INFO', `Socials: ${Object.keys(data).filter(k => !["emails", "contact_name"].includes(k)).join(", ") || "none"}`);

        await pool.execute(
          `UPDATE jobs
           SET emails = ?, contact_name = ?, status = 'emails_found'
           WHERE job_id = ?`,
          [JSON.stringify(data), data.contact_name, job.job_id]
        );

      } catch (err) {
        log('ERROR', `Error scraping ${job.job_id}: ${err.message}`);
        await pool.execute(
          `UPDATE jobs SET status = 'failed', error = ? WHERE job_id = ?`,
          [err.message, job.job_id]
        );
      }

      await new Promise(r => setTimeout(r, 500));
    }

  } catch (err) {
    log('ERROR', `Run error: ${err.message}`);
  } finally {
    log('INFO', 'Email scraper done. Closing pool...');
    await pool.end();
  }
}

process.on('SIGINT', async () => {
  log('INFO', 'Gracefully shutting down...');
  await pool.end();
  process.exit(0);
});

run();