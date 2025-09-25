// src/middleware/auth.js
function isAuthed(req) {
  return !!(req.session && req.session.user);
}

// Require a logged-in user
function ensureAuthenticated(req, res, next) {
  if (isAuthed(req)) return next();
  // allow health & static to pass through without loop
  const p = req.path || req.originalUrl || '/';
  if (p.startsWith('/login') || p.startsWith('/public') || p.startsWith('/assets') || p === '/healthz') {
    return next();
  }
  return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl || '/')}`);
}

// Ensure the user is NOT logged in (for /login)
function ensureGuest(req, res, next) {
  if (isAuthed(req)) {
    return res.redirect('/dashboard');
  }
  return next();
}

module.exports = { ensureAuthenticated, ensureGuest, isAuthed };
