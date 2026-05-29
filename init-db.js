const pool = require('./src/utils/db');
const { log } = require('./src/utils/logger/logger');
require('dotenv').config();

async function init() {
  log('INFO', 'Initializing database...');

  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS jobs (
        job_id VARCHAR(255) PRIMARY KEY,
        title VARCHAR(500) NOT NULL,
        description TEXT,
        type JSON,
        budget VARCHAR(255),
        job_link TEXT,
        company_website VARCHAR(500),
        emails JSON,
        proposal TEXT,
        status ENUM('scraped','enriching','enriched','proposal_ready','sent','failed') DEFAULT 'scraped',
        email_sent TINYINT(1) DEFAULT 0,
        website_checked TINYINT(1) DEFAULT 0,
        ai_processed TINYINT(1) DEFAULT 0,
        email_checked TINYINT(1) DEFAULT 0,
        error TEXT,
        scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    log('INFO', 'Table created or already exists');
    log('INFO', 'Database initialized successfully');
  } catch (err) {
    log('ERROR', `Database initialization failed: ${err.message}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

init();