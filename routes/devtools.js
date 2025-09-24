const express = require('express');
const seed = require('../db/seed');

const router = express.Router();

/**
 * Run seeding from the browser:
 *   GET /dev/seed?token=YOUR_DEV_TOKEN
 * Requires env DEV_TOKEN to match the query token.
 */
router.get('/dev/seed', async (req, res) => {
  const token = req.query.token || '';
  const expected = process.env.DEV_TOKEN || '';
  if (!expected || token !== expected) {
    return res.status(401).send('Unauthorized');
  }
  try {
    const result = await seed();
    res.json({ ok: true, result });
  } catch (e) {
    console.error('Dev seed error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
