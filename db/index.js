const { Pool } = require('pg');

const isProd = process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProd ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
  console.error('PG pool error', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
