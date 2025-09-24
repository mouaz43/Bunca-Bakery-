const express = require('express');
const { ensureAuthenticated } = require('../middleware/auth');
const { ensureAdmin } = require('../middleware/roles');
const { setFlash } = require('../middleware/flash');
const seedFromFiles = require('../db/seed_from_files');

const router = express.Router();
router.use(ensureAuthenticated, ensureAdmin);

// GET /admin/seed-files?replace=1
router.get('/admin/seed-files', async (req, res) => {
  const replace = String(req.query.replace || '').toLowerCase() === '1';
  const outcome = await seedFromFiles({ replaceBOM: replace });
  if (outcome.ok) {
    setFlash(req, 'ok', `Seed OK: ${JSON.stringify(outcome.result)}`);
  } else {
    setFlash(req, 'error', `Seed FEHLER: ${outcome.error}`);
  }
  res.redirect('/admin');
});

module.exports = router;
