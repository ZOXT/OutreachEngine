# Automated AI Job Outreach Pipeline

An end-to-end automation platform that continuously scrapes job listings, enriches company data using LLMs, discovers contact information, generates highly personalised outreach proposals, and sends automated cold emails at scale.

Designed as a resilient, restart-safe pipeline with AI enrichment, rate limiting, batching, retry handling, and multi-stage processing.

---

<h1>System Architecture</h1>
 <p>
  <img src="./docs/pipeline-diagram.jfif" width="700"/> </p>

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
MySQL Database
        ↓
enricher.js (LLM Processing)
        ↓
email-scraper.js (Contact Discovery)
        ↓
email-sender.js (Brevo SMTP)
```

---

# Core Components

| Component          | Responsibility                                                                          |
| ------------------ | --------------------------------------------------------------------------------------- |
| `scraper.js`       | Scrapes external job boards and inserts raw listings into MySQL                         |
| `enricher.js`      | Uses Groq LLMs to extract company metadata and generate personalised outreach proposals |
| `email-scraper.js` | Crawls company websites and extracts verified contact information                       |
| `email-sender.js`  | Sends personalised outreach emails with delivery tracking and retry logic               |

---

# Tech Stack

| Layer           | Technology                             |
| --------------- | -------------------------------------- |
| Runtime         | Node.js 22+                            |
| Database        | MySQL 8 (AWS RDS)                      |
| AI Processing   | Groq API (Llama 3.3-70B, Llama 3.1-8B) |
| Email Delivery  | Nodemailer + Brevo SMTP                |
| Scraping        | Axios + Cheerio                        |
| Anti-Bot Bypass | FlareSolverr                           |
| Hosting         | AWS EC2                                |
| Reverse Proxy   | Nginx                                  |

---

# Idempotent Pipeline Design

Each job progresses through deterministic processing states:

```text
scraped → enriching → enriched → emails_found → sent / failed
```

This architecture ensures:

* No duplicate processing
* Safe restarts
* Crash recovery
* Retry-safe execution
* Incremental progress tracking

---

# Reliability Features

## Fault Tolerance

* Graceful shutdown handling (`SIGINT`)
* Exponential backoff retries
* Batch processing
* Automatic status recovery
* Connection cleanup

## Anti-Detection Measures

* Request throttling
* Configurable delays
* Batched scraping
* Cloudflare bypass via FlareSolverr

## Data Quality Controls

* Invalid email filtering
* Placeholder detection
* Social profile extraction
* AI-assisted contact verification

---

# Setup

## 1. Clone Repository

```bash
git clone https://github.com/ZOXT/OutreachEngine.git
cd OutreachEngine
```

---

## 2. Install Dependencies

```bash
npm install
```

---

## 3. Configure Environment Variables

Create a `.env` file:

```ini
# Database
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=yourpassword
DB_NAME=outreach

# Groq API
GROQ_API_KEY=your_groq_key

# Scraping
SCRAPE_URL=https://example.com/jobs?q=developer
BASE_URL=https://example.com

# Brevo SMTP
BREVO_HOST=smtp-relay.brevo.com
BREVO_PORT=587
BREVO_USER=your_smtp_user
BREVO_PASS=your_smtp_password
BREVO_FROM=hello@yourdomain.com
```

---

## 4. Initialise Database

```bash
mysql -u root -p < schema/init-db.sql
```

---

## 5. Start FlareSolverr

```bash
docker run -d -p 8191:8191 ghcr.io/flaresolverr/flaresolverr:latest
```

---

## 6. Run Pipeline

```bash
node src/pipeline/scraper.js

node src/pipeline/enricher.js

node src/pipeline/email-scraper.js

node src/pipeline/email-sender.js
```

---

# Cron Automation (EC2 Example)

```cron
*/5 * * * * cd /home/ubuntu/outreach-engine && node src/pipeline/scraper.js >> /var/log/scraper.log 2>&1

*/5 * * * * cd /home/ubuntu/outreach-engine && node src/pipeline/enricher.js >> /var/log/enricher.log 2>&1

*/5 * * * * cd /home/ubuntu/outreach-engine && node src/pipeline/email-scraper.js >> /var/log/email-scraper.log 2>&1

*/10 * * * * cd /home/ubuntu/outreach-engine && node src/pipeline/email-sender.js >> /var/log/email-sender.log 2>&1
```

---

# Engineering Challenges & Solutions

| Challenge                                                                   | Solution                                                                                                                                                                          |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cloudflare blocking returned "Just a moment..." instead of job listings** | Deployed FlareSolverr in Docker as a local headless-browser proxy with JavaScript rendering enabled, allowing the scraper to retrieve fully rendered HTML.                        |
| **MySQL `caching_sha2_password` authentication errors on AWS RDS**          | Updated the MySQL user authentication plugin to `mysql_native_password`, restoring compatibility with the Node.js `mysql2` driver.                                                |
| **AI-generated proposals sounded robotic and generic**                      | Built a structured conversion-focused prompt system with strategic observations, social proof, deterministic formatting, and lower model temperature (`0.3`) for natural outputs. |
| **Regex/CSS selectors failed to extract contact names reliably**            | Added a fallback AI extraction layer that scans homepage, `/about`, and `/contact` pages and returns either a valid first name or `"null"`.                                       |
| **Email extraction captured fake emails and image filenames**               | Added filters for `.png`, `.jpg`, `.webp`, `.svg`, and placeholder addresses such as `test@`, `example@`, and `noreply@`.                                                         |
| **Race conditions during overlapping cron executions**                      | Implemented a status-driven state machine (`scraped → enriching → enriched → emails_found → sent/failed`) to prevent duplicate processing.                                        |
| **Rate limiting and temporary IP blocks during scraping**                   | Added configurable delays (`300–500ms`), batched processing, rotating User-Agent headers, and human-like request pacing.                                                          |

---

# Repository Structure

```text
.
├── src/
│   ├── pipeline/
│   │   ├── scraper.js
│   │   ├── enricher.js
│   │   ├── email-scraper.js
│   │   └── email-sender.js
│   │
│   └── utils/
│       ├── db.js
│       ├── logger.js
│       └── mail.js
│
├── schema/
│   └── init-db.sql
│
├── docs/
│   └── pipeline-diagram.png
│
├── .env.example
├── package.json
└── README.md
```

---

# Future Improvements

* Queue-based orchestration (BullMQ / RabbitMQ)
* Multi-threaded workers
* Proxy rotation
* Dashboard & analytics
* OpenTelemetry tracing
* Kubernetes deployment
* AI ranking/scoring system

---

# License

MIT

---

Built as a demonstration of scalable automation architecture, AI-powered workflow orchestration, resilient pipeline engineering, intelligent outreach systems, and distributed-style background job processing.

