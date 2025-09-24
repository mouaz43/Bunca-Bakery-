// routes/seedfiles.js
const express = require('express');
const { ensureAuthenticated } = require('../middleware/auth');
const { ensureAdmin } = require('../middleware/roles');
const { setFlash } = require('../middleware/flash');
const seedFromFiles = require('../db/seed_from_files');

const router = express.Router();
router.use(ensureAuthenticated, ensureAdmin);

// UI page with buttons
router.get('/admin/seed-files', (_req, res) => {
  res.render('admin/seed_files', { title: 'Seed aus Repo (JSON)' });
});

// Form submit → run seed
router.post('/admin/seed-files', async (req, res) => {
  const replace = String(req.body.replace_bom || '').toLowerCase() === 'on';
  const outcome = await seedFromFiles({ replaceBOM: replace });
  if (outcome.ok) {
    setFlash(req, 'ok', `Seed OK: ${JSON.stringify(outcome.result)}`);
  } else {
    setFlash(req, 'error', `Seed FEHLER: ${outcome.error}`);
  }
  res.redirect('/admin');
});

// Optional: direct links that run immediately
router.get('/admin/seed-files/run', async (_req, res) => {
  const outcome = await seedFromFiles({ replaceBOM: false });
  res.redirect(`/admin?seed=${outcome.ok ? 'ok' : 'err'}`);
});
router.get('/admin/seed-files/run?replace=1', async (_req, res) => {
  const outcome = await seedFromFiles({ replaceBOM: true });
  res.redirect(`/admin?seed=${outcome.ok ? 'ok' : 'err'}`);
});

module.exports = router;
