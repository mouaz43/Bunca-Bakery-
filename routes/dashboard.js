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

router.get('/recipes', ensureAuthenticated, (req, res) => {
  res.render('dashboard/placeholder', { title: 'Recipes', label: 'Recipes (coming next)' });
});
router.get('/products', ensureAuthenticated, (req, res) => {
  res.render('dashboard/placeholder', { title: 'Rohwaren', label: 'Rohwaren (siehe Admin)' });
});

module.exports = router;
