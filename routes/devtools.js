const express = require('express');
const seed = require('../db/seed');

const router = express.Router();

/** helpers */
function tokenFrom(req) {
  // Accept ?token=... or header x-dev-token
  return (req.query.token || req.headers['x-dev-token'] || '').toString().trim();
}
function unauthorized(res, reason = 'Unauthorized') {
  return res.status(401).send(reason);
}

/**
 * Simple ping to verify your token works:
 *   GET /dev/ping?token=YOUR_DEV_TOKEN
 */
router.get('/dev/ping', (req, res) => {
  const expected = (process.env.DEV_TOKEN || '').trim();
  const incoming = tokenFrom(req);
  if (!expected) return unauthorized(res, 'Unauthorized (DEV_TOKEN not set on server)');
  if (incoming !== expected) return unauthorized(res, 'Unauthorized (bad or missing token)');
  res.json({ ok: true, message: 'Token valid. You can run /dev/seed now.' });
});

/**
 * Run the DB seed (creates admin user from env):
 *   GET /dev/seed?token=YOUR_DEV_TOKEN
 * Needs env vars:
 *   ADMIN_EMAIL, ADMIN_PASSWORD, DEV_TOKEN
 */
router.get('/dev/seed', async (req, res) => {
  const expected = (process.env.DEV_TOKEN || '').trim();
  const incoming = tokenFrom(req);
  if (!expected) return unauthorized(res, 'Unauthorized (DEV_TOKEN not set on server)');
  if (incoming !== expected) return unauthorized(res, 'Unauthorized (bad or missing token)');

  try {
    const result = await seed();
    res.json({ ok: true, result });
  } catch (e) {
    console.error('Dev seed error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * (Optional) Inspect relevant envs without secrets:
 *   GET /dev/env?token=YOUR_DEV_TOKEN
 */
router.get('/dev/env', (req, res) => {
  const expected = (process.env.DEV_TOKEN || '').trim();
  const incoming = tokenFrom(req);
  if (!expected) return unauthorized(res, 'Unauthorized (DEV_TOKEN not set on server)');
  if (incoming !== expected) return unauthorized(res, 'Unauthorized (bad or missing token)');

  const adminEmail = (process.env.ADMIN_EMAIL || '').trim();
  const adminPassSet = !!(process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length);
  res.json({
    ok: true,
    admin_email: adminEmail || '(not set)',
    admin_password_set: adminPassSet,
    has_database_url: !!process.env.DATABASE_URL,
  });
});

module.exports = router;
