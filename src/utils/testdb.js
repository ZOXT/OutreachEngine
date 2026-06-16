const pool = require('../utils/db');

(async () => {
  try {
    const conn = await pool.getConnection();
    console.log('DB connected');
    conn.release();
  } catch (err) {
    console.error('DB connection failed', err);
  }
})();


