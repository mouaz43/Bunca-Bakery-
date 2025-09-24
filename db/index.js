const { Pool } = require('pg');

const isProd = process.env.NODE_ENV === 'production';
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error(
    '❌ DATABASE_URL is missing.\n' +
    'On Render: create a Postgres instance, copy its External Database URL, ' +
    'and set it as DATABASE_URL in your Web Service → Environment.'
  );
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: isProd ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
  console.error('PG pool error:', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
