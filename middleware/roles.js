// middleware/roles.js
function ensureAdmin(req, res, next) {
  if (req.session?.user?.role === 'admin') return next();
  return res.status(403).render('dashboard/placeholder', {
    title: '403',
    label: 'Nur Admins dürfen diese Seite sehen.'
  });
}

module.exports = { ensureAdmin };
