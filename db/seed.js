require('dotenv').config();
const bcrypt = require('bcrypt');
const db = require('./index');

async function seed() {
  console.log('Running seed...');
  // Shops
  await db.query(
    `INSERT INTO shops (code, name) VALUES 
     ('CITY','City'),('BER','Berger'),('GBW','Grüneburgweg')
     ON CONFLICT (code) DO NOTHING`
  );

  // Settings defaults
  await db.query(
    `INSERT INTO settings (key, value_json) VALUES
     ('recipesLocked', '{"value": false}'),
     ('costsVisible', '{"value": false}')
     ON CONFLICT (key) DO NOTHING`
  );

  // Units minimal set
  await db.query(
    `INSERT INTO units (code, label, ratio_to_base) VALUES
     ('g','Gramm',1),
     ('kg','Kilogramm',1000),
     ('ml','Milliliter',1),
     ('l','Liter',1000),
     ('pcs','Stück',1)
     ON CONFLICT (code) DO NOTHING`
  );

  // Admin user (from env)
  const envEmail = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
  const envPass  = process.env.ADMIN_PASSWORD || '';
  if (!envEmail || !envPass) {
    console.log('Skip admin seed: ADMIN_EMAIL/ADMIN_PASSWORD missing.');
    return { ok: true, admin: 'skipped' };
  }

  const { rows } = await db.query('SELECT id FROM users WHERE email=$1', [envEmail]);
  if (rows.length === 0) {
    const hash = await bcrypt.hash(envPass, 12);
    await db.query(
      `INSERT INTO users (email, password_hash, role, recipe_access) VALUES ($1,$2,'admin',true)`,
      [envEmail, hash]
    );
    console.log(`Admin user created: ${envEmail}`);
    return { ok: true, admin: 'created', email: envEmail };
  } else {
    console.log('Admin already exists, skipping.');
    return { ok: true, admin: 'exists', email: envEmail };
  }
}

module.exports = seed;

// allow running as CLI: `node db/seed.js`
if (require.main === module) {
  seed()
    .then((r) => { console.log('Seed complete:', r); process.exit(0); })
    .catch((e) => { console.error('Seed failed:', e); process.exit(1); });
}
