const express = require('express');
const dayjs = require('dayjs');
const { ensureAuthenticated } = require('../middleware/auth');

const router = express.Router();

router.get('/', ensureAuthenticated, async (req, res) => {
  const today = dayjs().tz ? dayjs().tz('Europe/Berlin') : dayjs(); // fallback if tz plugin not loaded
  res.render('dashboard/index', {
    title: 'Dashboard',
    todayISO: today.format('YYYY-MM-DD'),
    greeting: 'Willkommen bei Bunca Bakery Planner'
  });
});

// Placeholder routes (secured) — to be built in next steps
router.get('/production', ensureAuthenticated, (req, res) => {
  res.render('dashboard/placeholder', { title: 'Production Plan', label: 'Production Plan (coming next)' });
});
router.get('/recipes', ensureAuthenticated, (req, res) => {
  res.render('dashboard/placeholder', { title: 'Recipes', label: 'Recipes (coming next)' });
});
router.get('/products', ensureAuthenticated, (req, res) => {
  res.render('dashboard/placeholder', { title: 'Rohwaren', label: 'Rohwaren (coming next)' });
});
router.get('/admin', ensureAuthenticated, (req, res) => {
  res.render('dashboard/placeholder', { title: 'Admin', label: 'Admin (coming next)' });
});

module.exports = router;
