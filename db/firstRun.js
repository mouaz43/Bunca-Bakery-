// db/firstRun.js
const db = require('./index');
const seed = require('./seed');

/**
 * If there are no users yet, run the seed (creates admin from env,
 * inserts shops, settings, and units). Safe to call on every boot.
 */
module.exports = async function firstRunSeedIfEmpty() {
  try {
    const { rows } = await db.query('SELECT COUNT(*)::int AS c FROM users');
    const count = rows?.[0]?.c ?? 0;
    if (count === 0) {
      console.log('👤 No users found. Running initial seed…');
      const result = await seed();
      console.log('👤 Seed result:', result);
    } else {
      console.log('👤 Users already exist, skipping first-run seed.');
    }
  } catch (e) {
    console.error('First-run seed check failed:', e);
  }
};
