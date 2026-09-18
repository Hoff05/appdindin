'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

async function verifyScrypt(password, encoded) {
  const [algorithm, nText, rText, pText, saltBase64, expectedHex] = String(encoded || '').split('$');
  if (algorithm !== 'scrypt' || !saltBase64 || !expectedHex) return false;
  const N = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  if (![N, r, p].every(Number.isSafeInteger)) return false;

  const expected = Buffer.from(expectedHex, 'hex');
  if (expected.length === 0) return false;
  const derived = await scrypt(String(password || ''), Buffer.from(saltBase64, 'base64'), expected.length, {
    N, r, p, maxmem: 64 * 1024 * 1024,
  });
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

function csrfProtection(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('base64url');
  res.locals.csrfToken = req.session.csrfToken;
  if (req.method !== 'POST') return next();

  const supplied = Buffer.from(String(req.body?._csrf || ''));
  const expected = Buffer.from(req.session.csrfToken);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    return res.status(403).send('Requisição inválida. Atualize a página e tente novamente.');
  }
  return next();
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  res.locals.currentUser = req.session.user;
  return next();
}

module.exports = { csrfProtection, requireAuth, verifyScrypt };
