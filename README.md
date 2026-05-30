# OutreachEngine

An end-to-end automation platform that continuously scrapes job listings, enriches company data using LLMs, discovers contact information, generates highly personalised outreach proposals, and sends automated cold emails at scale.

Designed as a resilient, restart-safe pipeline with AI enrichment, rate limiting, batching, retry handling, and multi-stage processing.

---

<h1>System Architecture</h1>
<p>
  <img src="./docs/pipeline-diagram.jfif" width="700"/>
</p>

---

# Overview

This project demonstrates:

* AI-powered data enrichment
* Automated lead generation
* Intelligent outreach automation
* Contact discovery pipelines
* Fault-tolerant workflow orchestration
* Idempotent distributed-style processing
* Real-world scraping infrastructure

The system continuously processes jobs through multiple stages while preventing duplicate execution and supporting safe restarts.

---

# Pipeline Flow

```text
External Job Sites
        ↓
scraper.js
        ↓
MySQL Database (AWS RDS)
        ↓
enricher.js (Groq LLM — website + company + proposal in one call)
        ↓
email-scraper.js (Contact Discovery + AI name extraction)
        ↓
email-sender.js (Brevo SMTP — personalised with contact name)
```

---

# Core Components

| Component          | Responsibility                                                                          |
| ------------------ | --------------------------------------------------------------------------------------- |
| `scraper.js`       | Scrapes external job boards via FlareSolverr and inserts raw listings into MySQL        |
| `enricher.js`      | Single Groq LLM call extracts company website, name, contact, subject line and proposal |
| `email-scraper.js` | Crawls company websites for emails and uses AI to extract contact names                 |
| `email-sender.js`  | Sends personalised outreach emails with greeting, subject line and delivery tracking    |

---

# Tech Stack

| Layer           | Technology                              |
| --------------- | --------------------------------------- |
| Runtime         | Node.js 22+                             |
| Database        | MySQL 8 (AWS RDS)                       |
| AI Processing   | Groq API (Llama 3.3-70B, Llama 3.1-8B) |
| Email Delivery  | Nodemailer + Brevo SMTP                 |
| Scraping        | Axios + Cheerio                         |
| Anti-Bot Bypass | FlareSolverr                            |
| Process Manager | PM2 (cron-based, EC2)                   |
| Hosting         | AWS EC2 (t3.micro)                      |
| Database Host   | AWS RDS (MySQL 8.4)                     |
| Reverse Proxy   | Nginx (with basic auth)                 |
| Logging         | Custom file logger with timestamps      |

---

# Idempotent Pipeline Design

Each job progresses through deterministic processing states:

```text
scraped → enriching → enriched → emails_found → sent / failed
```

This status-driven state machine ensures:

* No duplicate processing — each stage checks status before acting
* Safe restarts — scripts can be rerun without side effects
* Crash recovery — stale `enriching` jobs auto-retry after 10 minutes
* Incremental progress — pipeline picks up exactly where it left off

---

# Reliability Features

## Fault Tolerance

* Graceful shutdown on `SIGINT` with double-call guard
* Exponential backoff retries (2s, 4s) on Groq API failures
* Batch processing (10 jobs per run) to limit blast radius
* Stale state recovery for jobs stuck in `enriching`
* DB connection cleanup on exit

## Anti-Detection Measures

* FlareSolverr headless browser proxy for Cloudflare bypass
* Configurable request delays (300–500ms between pages, 1s between emails)
* Batched scraping to avoid rate limits

## Data Quality Controls

* Invalid email filtering (image filenames, placeholder addresses, Sentry addresses)
* Obfuscated email detection (`[at]`, `[dot]` patterns)
* AI-assisted contact name extraction from website content
* Proposal validation — rejects outputs under 50 characters and retries
* JSON sanitizer strips markdown backticks from LLM responses

---

# Setup

## Prerequisites

* Node.js 18+
* MySQL database (AWS RDS or local)
* Docker (for FlareSolverr)
* Groq API key — free at [console.groq.com](https://console.groq.com)
* Brevo account — free at [brevo.com](https://brevo.com)

## 1. Clone Repository

```bash
git clone https://github.com/ZOXT/OutreachEngine.git
cd OutreachEngine
```

## 2. Install Dependencies

```bash
npm install
```

## 3. Configure Environment Variables

```bash
cp .env.example .env
nano .env  # fill in your credentials
```

```ini
# Database
DB_HOST=your-rds-endpoint.rds.amazonaws.com
DB_USER=admin
DB_PASSWORD=yourpassword
DB_NAME=scraper_db
DB_PORT=3306

# Groq AI
GROQ_API_KEY=gsk_your_key_here

# Scraping
SCRAPE_URL=https://example.com/jobs?q=developer&sort=recency
BASE_URL=https://example.com

# Brevo SMTP
BREVO_HOST=smtp-relay.brevo.com
BREVO_PORT=587
BREVO_USER=your_smtp_user
BREVO_PASS=your_smtp_password
BREVO_FROM=you@yourdomain.com
```

## 4. Initialise Database

```bash
node init-db.js
```

## 5. Start FlareSolverr

```bash
docker run -d -p 8191:8191 --name flaresolverr ghcr.io/flaresolverr/flaresolverr:latest
```

## 6. Run Pipeline Manually

```bash
node src/pipeline/scraper.js
node src/pipeline/enricher.js
node src/pipeline/email-scraper.js
node src/pipeline/email-sender.js
```

---

# Automated Deployment with PM2 (EC2)

PM2 manages all pipeline stages as scheduled cron jobs. Each script runs on a staggered schedule so stages execute sequentially.

## Install PM2

```bash
npm install -g pm2
```

## Start All Stages

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # auto-start on EC2 reboot
```

## ecosystem.config.js

```javascript
module.exports = {
  apps: [
    {
      name: 'scraper',
      script: 'src/pipeline/scraper.js',
      cron_restart: '*/30 * * * *',
      autorestart: false,
      instances: 1,
      kill_timeout: 5000,
    },
    {
      name: 'enricher',
      script: 'src/pipeline/enricher.js',
      cron_restart: '5-59/30 * * * *',
      autorestart: false,
      instances: 1,
      kill_timeout: 5000,
    },
    {
      name: 'email-scraper',
      script: 'src/pipeline/email-scraper.js',
      cron_restart: '10-59/30 * * * *',
      autorestart: false,
      instances: 1,
      kill_timeout: 5000,
    },
    {
      name: 'email-sender',
      script: 'src/pipeline/email-sender.js',
      cron_restart: '15-59/30 * * * *',
      autorestart: false,
      instances: 1,
      kill_timeout: 5000,
    },
  ]
};
```

## Useful PM2 Commands

```bash
pm2 list                    # view all processes
pm2 logs                    # tail all logs
pm2 logs scraper            # tail specific script
pm2 restart all             # restart everything
pm2 stop all                # stop everything
```

---

# Engineering Challenges & Solutions

| Challenge | Solution |
| --------- | -------- |
| **Cloudflare blocking scraper with "Just a moment..."** | Deployed FlareSolverr in Docker as a headless-browser proxy with JavaScript rendering, allowing full page execution before HTML is returned |
| **MySQL `caching_sha2_password` incompatibility on AWS RDS 8.4** | Migrated admin user to `mysql_native_password` via `ALTER USER` to restore Node.js mysql2 driver compatibility |
| **LLM proposals sounded robotic and generic** | Built a structured prompt with client-type analysis, social proof references, strategic framing rules, and explicit forbidden phrases |
| **Single LLM call needed to return structured + creative output** | Combined website extraction, company name, contact name, subject line, and proposal into one JSON response with retry and sanitizer fallback |
| **Contact name couldn't be reliably matched to specific emails** | Used AI to scan homepage and about/contact pages for owner/founder names, stored separately and used only as a greeting prefix |
| **Email extraction picked up image filenames as addresses** | Added regex filter blocking `.png`, `.jpg`, `.webp`, `.svg` extensions and known placeholder/tracking domains |
| **Jobs stuck in `enriching` state after crash** | Added automatic recovery: enricher query includes jobs where `status = 'enriching' AND updated_at < NOW() - INTERVAL 10 MINUTE` |
| **Duplicate processing on pipeline restarts** | Status-driven state machine ensures each stage only picks up jobs in the correct preceding status |
| **PM2 SIGKILL before DB pool closes cleanly** | Added `isShuttingDown` guard flag and `kill_timeout: 5000` to give scripts time to close connections gracefully |

---

# Repository Structure

```text
OutreachEngine/
├── src/
│   ├── pipeline/
│   │   ├── scraper.js           # Stage 1 — fetch job listings
│   │   ├── enricher.js          # Stage 2 — LLM enrichment + proposal
│   │   ├── email-scraper.js     # Stage 3 — contact discovery
│   │   └── email-sender.js      # Stage 4 — personalised outreach
│   │
│   └── utils/
│       ├── db.js                # MySQL connection pool
│       ├── mail.js              # Brevo SMTP transporter
│       └── logger/
│           └── logger.js        # File + console logger
│
├── schema/
│   └── init-db.js               # Database schema setup
│
├── docs/
│   └── pipeline-diagram.jfif    # Architecture diagram
│
├── ecosystem.config.js          # PM2 process config
├── .env.example
├── package.json
└── README.md
```

---

# Future Improvements

* Queue-based orchestration (BullMQ / Redis)
* Multi-threaded parallel workers
* Proxy rotation for scraping resilience
* React dashboard with pipeline analytics
* OpenTelemetry distributed tracing
* Fine-tuned proposal model on successful outreach data
* Hunter.io fallback for email discovery

---

# License

MIT

---

Built as a demonstration of scalable automation architecture, AI-powered workflow orchestration, resilient pipeline engineering, and production-grade deployment on AWS.