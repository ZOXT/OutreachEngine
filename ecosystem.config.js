module.exports = {
  apps: [
    {
      name: 'scraper',
      script: 'src/pipeline/scraper.js',
      cron_restart: '*/30 * * * *',  // At :00 and :30
      autorestart: false,
      instances: 1,
    },
    {
      name: 'enricher',
      script: 'src/pipeline/enricher.js',
      cron_restart: '5-59/30 * * * *',  // At :05 and :35 (5 mins after scraper)
      autorestart: false,
      instances: 1,
    },
    {
      name: 'email-scraper',
      script: 'src/pipeline/email-scraper.js',
      cron_restart: '10-59/30 * * * *',  // At :10 and :40
      autorestart: false,
      instances: 1,
    },
    {
      name: 'email-sender',
      script: 'src/pipeline/email-sender.js',
      cron_restart: '15-59/30 * * * *',  // At :15 and :45
      autorestart: false,
      instances: 1,
    },
  ]
};