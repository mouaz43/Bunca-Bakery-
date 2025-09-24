// Tiny flash helper using session (no extra deps)
function attachFlash() {
  return (req, res, next) => {
    res.locals.flash = req.session.flash || null;
    res.locals.user = req.session.user || null;
    delete req.session.flash;
    next();
  };
}

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

module.exports = { attachFlash, setFlash };
