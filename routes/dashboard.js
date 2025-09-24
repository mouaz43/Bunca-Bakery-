const express = require('express');
const dayjs = require('dayjs');
const { ensureAuthenticated } = require('../middleware/auth');

const router = express.Router();

router.get('/', ensureAuthenticated, async (req, res) => {
  const today = dayjs().format('YYYY-MM-DD');
  res.render('dashboard/index', {
    title: 'Dashboard',
    todayISO: today,
    greeting: 'Willkommen bei Bunca Bakery Planner'
  });
});

// keep placeholders for now (we’ll replace in next steps)
router.get('/production', ensureAuthenticated, (req, res) => {
  res.render('dashboard/placeholder', { title: 'Production Plan', label: 'Production Plan (coming next)' });
});
router.get('/recipes', ensureAuthenticated, (req, res) => {
  res.render('dashboard/placeholder', { title: 'Recipes', label: 'Recipes (coming next)' });
});
router.get('/products', ensureAuthenticated, (req, res) => {
  res.render('dashboard/placeholder', { title: 'Rohwaren', label: 'Rohwaren (coming next)' });
});

module.exports = router;
