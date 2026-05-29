const axios = require("axios");
const cheerio = require("cheerio");
const pool = require('../utils/db');
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { log } = require('../utils/logger/logger');

async function fetchPage() {
  let response;

  try {
    response = await axios.post("http://localhost:8191/v1", {
      cmd: "request.get",
      url: process.env.SCRAPE_URL,
      maxDepth: 1,
      maxTimeout: 120000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
      },
      render: true,
      scriptingEnabled: true
    });
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      throw new Error('FlareSolverr is not running on port 8191. Start it with: docker run -d -p 8191:8191 ghcr.io/flaresolverr/flaresolverr:latest');
    }
    throw new Error(`FlareSolverr request failed: ${err.message}`);
  }

  if (response.data?.status === 'error') {
    throw new Error(`FlareSolverr error: ${response.data?.message}`);
  }

  if (!response.data?.solution?.response) {
    throw new Error('FlareSolverr returned empty response');
  }

  return response.data.solution.response;
}

function extractBudget(typeArray) {
  if (!Array.isArray(typeArray)) return null;
  for (const item of typeArray) {
    const match = item.match(/\$[\d,.]+/);
    if (match) return match[0];
  }
  return null;
}

async function saveJobsBulk(jobs) {
  if (!jobs.length) return;

  try {
    const sql = `
      INSERT INTO jobs 
      (job_id, title, description, type, budget, job_link, status)
      VALUES ?
      ON DUPLICATE KEY UPDATE
        title = VALUES(title),
        description = VALUES(description),
        type = VALUES(type),
        budget = VALUES(budget),
        job_link = VALUES(job_link),
        updated_at = CURRENT_TIMESTAMP
    `;

    const values = jobs.map(job => [
      job.job_id,
      job.title,
      job.description,
      JSON.stringify(job.type),
      job.budget,
      job.job_url,
      'scraped'
    ]);

    const [result] = await pool.query(sql, [values]);
    log('INFO', `Inserted/updated: ${result.affectedRows} rows`);
  } catch (err) {
    log('ERROR', `DB save error: ${err.message}`);
  }
}

async function main() {
  log('INFO', 'Starting scraper...');

  let html;
  try {
    html = await fetchPage();
  } catch (err) {
    log('ERROR', `Failed to fetch page: ${err.message}`);
    await pool.end();
    process.exit(1);
  }

  const $ = cheerio.load(html);
  const jobs = [];

  $("article.job-tile").each((i, el) => {
    const job_id = $(el).attr("data-ev-job-uid") || "";
    const title = $(el).find("h2.job-tile-title a").first().text().trim();

    const relativejobUrl = $(el)
      .find("h2.job-tile-title a.air3-link")
      .first()
      .attr("href");

    const job_url = relativejobUrl
      ? `${process.env.BASE_URL}${relativejobUrl}`
      : null;

    const type = $(el)
      .find("ul.job-tile-info-list li")
      .map((i, li) => $(li).text().trim())
      .get();

    const description = $(el)
      .find('div[data-test*="JobDescription"] p.mb-0')
      .map((i, p) => $(p).text().trim())
      .get()
      .join(" ");

    const budget = extractBudget(type);

    if (title) {
      jobs.push({ job_id, title, job_url, type, description, budget });
    }
  });

  if (jobs.length === 0) {
    log('ERROR', 'No jobs found in HTML — Cloudflare may have blocked the request or page structure changed');
    await pool.end();
    process.exit(1);
  }

  log('INFO', `Total jobs found: ${jobs.length}`);
  await saveJobsBulk(jobs);
  log('INFO', `Scraper done. Jobs processed: ${jobs.length}`);
  await pool.end();
}

process.on('SIGINT', async () => {
  log('INFO', 'Gracefully shutting down...');
  await pool.end();
  process.exit(0);
});

main();