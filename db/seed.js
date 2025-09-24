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

  // Admin user
  const email = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password) {
    console.log('Skip admin seed: ADMIN_EMAIL/ADMIN_PASSWORD missing.');
    return;
  }

  const { rows } = await db.query('SELECT id FROM users WHERE email=$1', [email]);
  if (rows.length === 0) {
    const hash = await bcrypt.hash(password, 12);
    await db.query(
      `INSERT INTO users (email, password_hash, role, recipe_access) VALUES ($1,$2,'admin',true)`,
      [email, hash]
    );
    console.log(`Admin user created: ${email}`);
  } else {
    console.log('Admin already exists, skipping.');
  }
}

seed()
  .then(() => {
    console.log('Seed complete.');
    process.exit(0);
  })
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  });
