// const fs = require('fs');
// const path = require('path');

// const logDir = path.join(__dirname, '../../../logs');
// if (!fs.existsSync(logDir)) {
//   fs.mkdirSync(logDir, { recursive: true });
// }

// const logFile = path.join(logDir, 'pipeline.log');

// function log(level, message) {
//   const timestamp = new Date().toLocaleString('en-PK', { timeZone: 'Asia/Karachi' });
//   const textToAppend = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
//   console.log(textToAppend.trim()); // this stays as console.log — never change this line
//   fs.appendFileSync(logFile, textToAppend);
// }

// module.exports = { log };
const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, '../../../logs');

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const logFile = path.join(logDir, 'pipeline.log');

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function log(level, message) {
  const timestamp = new Date().toLocaleString('en-PK', {
    timeZone: 'Asia/Karachi',
  });

  const textToAppend = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;

  let color = colors.green;

  if (level.toLowerCase() === 'error') {
    color = colors.red;
  } else if (level.toLowerCase() === 'warn') {
    color = colors.yellow;
  } else if (level.toLowerCase() === 'info') {
    color = colors.cyan;
  }

  console.log(color + textToAppend.trim() + colors.reset);

  fs.appendFileSync(logFile, textToAppend);
}

module.exports = { log };