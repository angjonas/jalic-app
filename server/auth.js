import crypto from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import { HttpError, bad, str } from './util.js';

const scrypt = promisify(crypto.scrypt);
const SESSION_MS = 14 * 24 * 3600 * 1000;

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(pw, stored) {
  const [alg, s, k] = String(stored).split('$');
  if (alg !== 'scrypt' || !s || !k) return false;
  const key = await scrypt(pw, Buffer.from(s, 'hex'), 64);
  const expected = Buffer.from(k, 'hex');
  return expected.length === key.length && crypto.timingSafeEqual(expected, key);
}

export function checkPasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw bad('Use a password of at least 8 characters.');
  if (pw.length > 200) throw bad('That password is too long.');
}

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const publicUser = (u) => ({
  id: u.id, email: u.email, name: u.name, title: u.title || '', role: u.role,
  can_post: !!u.can_post || u.role === 'admin', is_admin: u.role === 'admin',
  birthday: u.birthday, hired_on: u.hired_on, must_change_pw: !!u.must_change_pw,
});

export function makeAuth({ db, secureCookies }) {
  const attempts = new Map(); // ip|email -> { n, until }

  function setCookie(res, token, maxAgeMs) {
    const parts = [`sid=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
    if (secureCookies) parts.push('Secure');
    res.append('Set-Cookie', parts.join('; '));
  }

  function loadUser(req, res, next) {
    const sid = parseCookies(req.headers.cookie).sid;
    if (sid) {
      const row = db.prepare(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`
      ).get(sha(sid), Date.now());
      if (row) { req.user = publicUser(row); req.sessionHash = sha(sid); }
    }
    next();
  }

  const requireUser = (req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'Please sign in.'));
    next();
  };
  const requireAuth = (req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'Please sign in.'));
    if (req.user.must_change_pw) return next(new HttpError(403, 'Please set a new password first.', { code: 'password_change_required' }));
    next();
  };
  const requireAdmin = (req, res, next) =>
    req.user?.is_admin ? next() : next(new HttpError(403, 'Only an office admin can do that.'));
  const requirePoster = (req, res, next) =>
    req.user?.can_post ? next() : next(new HttpError(403, 'Only admins and people with posting rights can do that.'));

  const router = express.Router();

  router.post('/login', async (req, res) => {
    const email = str(req.body?.email, { max: 200, field: 'Email', required: true }).toLowerCase();
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const key = `${req.ip}|${email}`;
    const a = attempts.get(key);
    if (a && a.n >= 8 && a.until > Date.now()) throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.');
    const u = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
    const ok = u ? await verifyPassword(password, u.password_hash) : (await verifyPassword(password, 'scrypt$00$00'), false);
    if (!ok) {
      attempts.set(key, { n: (a && a.until > Date.now() ? a.n : 0) + 1, until: Date.now() + 15 * 60 * 1000 });
      throw new HttpError(401, 'Email or password is incorrect.');
    }
    attempts.delete(key);
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha(token), u.id, Date.now() + SESSION_MS);
    setCookie(res, token, SESSION_MS);
    res.json({ user: publicUser(u) });
  });

  router.post('/logout', (req, res) => {
    if (req.sessionHash) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionHash);
    setCookie(res, '', 0);
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => res.json({ user: req.user || null }));

  router.post('/me/password', requireUser, async (req, res) => {
    const { current, next: nextPw } = req.body || {};
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!(await verifyPassword(String(current ?? ''), row.password_hash))) throw bad('Your current password is not correct.');
    checkPasswordStrength(nextPw);
    if (nextPw === current) throw bad('Choose a password different from the current one.');
    db.prepare('UPDATE users SET password_hash = ?, must_change_pw = 0 WHERE id = ?').run(await hashPassword(nextPw), req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(req.user.id, req.sessionHash);
    res.json({ ok: true });
  });

  return { router, loadUser, requireAuth, requireAdmin, requirePoster };
}
