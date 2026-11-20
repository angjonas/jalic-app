import express from 'express';
import { getSettings } from '../db.js';
import { hashPassword } from '../auth.js';
import { bad, notFound, str, int, num, oneOf, dateStr, birthday, tempPassword, parseCsv, HttpError } from '../util.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function userFields(b, { partial = false } = {}) {
  const out = {};
  const has = (k) => !partial || b[k] !== undefined;
  if (has('name')) out.name = str(b.name, { max: 80, field: 'Name', required: true });
  if (has('email')) {
    out.email = str(b.email, { max: 200, field: 'Email', required: true }).toLowerCase();
    if (!EMAIL_RE.test(out.email)) throw bad('That email address does not look right.');
  }
  if (has('title')) out.title = str(b.title, { max: 80, field: 'Job title' });
  if (has('role')) out.role = oneOf(b.role || 'member', ['admin', 'member'], 'Role');
  if (has('can_post')) out.can_post = b.can_post ? 1 : 0;
  if (has('birthday')) out.birthday = birthday(b.birthday);
  if (has('hired_on')) out.hired_on = dateStr(b.hired_on || null, 'Start date');
  if (partial && b.active !== undefined) out.active = b.active ? 1 : 0;
  return out;
}

export default function adminRoutes({ db, requireAuth, requireAdmin }) {
  const r = express.Router();
  r.use(requireAuth);

  // ----- directory & settings (everyone) -----
  r.get('/directory', (req, res) => {
    res.json({ people: db.prepare('SELECT id, name, title FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE').all() });
  });

  r.get('/settings', (req, res) => {
    const s = getSettings(db);
    res.json({
      office_name: s.office_name, timezone: s.timezone, parking_note: s.parking_note,
      geofence: {
        configured: s.geo_lat !== '' && s.geo_lng !== '',
        lat: s.geo_lat === '' ? null : Number(s.geo_lat), lng: s.geo_lng === '' ? null : Number(s.geo_lng),
        radius_m: Number(s.geo_radius_m), max_accuracy_m: Number(s.geo_max_accuracy_m),
      },
    });
  });

  r.put('/admin/settings', requireAdmin, (req, res) => {
    const b = req.body || {};
    const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    if (b.office_name !== undefined) set.run('office_name', str(b.office_name, { max: 80, field: 'Office name', required: true }));
    if (b.parking_note !== undefined) set.run('parking_note', str(b.parking_note, { max: 300 }));
    if (b.timezone !== undefined) {
      const tz = str(b.timezone, { max: 60, required: true, field: 'Timezone' });
      try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { throw bad('That timezone name is not recognised. Use a name like Asia/Manila.'); }
      set.run('timezone', tz);
    }
    if (b.geo_lat !== undefined || b.geo_lng !== undefined) {
      const lat = num(b.geo_lat, { min: -90, max: 90, field: 'Latitude' });
      const lng = num(b.geo_lng, { min: -180, max: 180, field: 'Longitude' });
      set.run('geo_lat', String(lat)); set.run('geo_lng', String(lng));
    }
    if (b.geo_radius_m !== undefined) set.run('geo_radius_m', String(num(b.geo_radius_m, { min: 20, max: 5000, field: 'Geofence radius' })));
    if (b.geo_max_accuracy_m !== undefined) set.run('geo_max_accuracy_m', String(num(b.geo_max_accuracy_m, { min: 10, max: 1000, field: 'Maximum GPS error' })));
    res.json({ ok: true });
  });

  // ----- resources (rooms & parking slots) -----
  r.get('/resources', (req, res) => {
    const kind = oneOf(req.query.kind, ['room', 'parking'], 'kind');
    res.json({ resources: db.prepare('SELECT id, kind, name, detail, capacity FROM resources WHERE kind = ? AND active = 1 ORDER BY name COLLATE NOCASE').all(kind) });
  });
  r.post('/admin/resources', requireAdmin, (req, res) => {
    const b = req.body || {};
    const kind = oneOf(b.kind, ['room', 'parking'], 'kind');
    const info = db.prepare('INSERT INTO resources (kind, name, detail, capacity) VALUES (?, ?, ?, ?)')
      .run(kind, str(b.name, { max: 60, field: 'Name', required: true }), str(b.detail, { max: 200 }) || null,
        kind === 'room' ? int(b.capacity, { min: 1, max: 500, field: 'Capacity', required: false }) : null);
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });
  r.patch('/admin/resources/:id', requireAdmin, (req, res) => {
    const row = db.prepare('SELECT * FROM resources WHERE id = ?').get(req.params.id);
    if (!row) throw notFound();
    const b = req.body || {};
    db.prepare('UPDATE resources SET name = ?, detail = ?, capacity = ? WHERE id = ?').run(
      b.name !== undefined ? str(b.name, { max: 60, field: 'Name', required: true }) : row.name,
      b.detail !== undefined ? str(b.detail, { max: 200 }) || null : row.detail,
      b.capacity !== undefined && row.kind === 'room' ? int(b.capacity, { min: 1, max: 500, field: 'Capacity', required: false }) : row.capacity,
      row.id);
    res.json({ ok: true });
  });
  r.delete('/admin/resources/:id', requireAdmin, (req, res) => {
    db.prepare('UPDATE resources SET active = 0 WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // ----- people -----
  r.get('/admin/users', requireAdmin, (req, res) => {
    res.json({ users: db.prepare('SELECT id, email, name, title, role, can_post, birthday, hired_on, active, must_change_pw FROM users ORDER BY active DESC, name COLLATE NOCASE').all() });
  });

  r.post('/admin/users', requireAdmin, async (req, res) => {
    const f = userFields(req.body || {});
    const pw = tempPassword();
    try {
      const info = db.prepare(
        `INSERT INTO users (email, name, title, password_hash, role, can_post, birthday, hired_on, must_change_pw, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
      ).run(f.email, f.name, f.title || null, await hashPassword(pw), f.role, f.can_post || 0, f.birthday, f.hired_on, Date.now());
      res.status(201).json({ id: Number(info.lastInsertRowid), temp_password: pw });
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'Someone already has that email address.');
      throw e;
    }
  });

  r.patch('/admin/users/:id', requireAdmin, (req, res) => {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!row) throw notFound();
    const f = userFields(req.body || {}, { partial: true });
    const next = { ...row, ...f };
    if (row.id === req.user.id && (next.role !== 'admin' || next.active === 0)) throw bad('You cannot remove your own admin access or deactivate yourself.');
    try {
      db.prepare('UPDATE users SET email=?, name=?, title=?, role=?, can_post=?, birthday=?, hired_on=?, active=? WHERE id=?')
        .run(next.email, next.name, next.title || null, next.role, next.can_post, next.birthday, next.hired_on, next.active, row.id);
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'Someone already has that email address.');
      throw e;
    }
    if (!next.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
    res.json({ ok: true });
  });

  r.post('/admin/users/:id/reset-password', requireAdmin, async (req, res) => {
    const row = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
    if (!row) throw notFound();
    const pw = tempPassword();
    db.prepare('UPDATE users SET password_hash = ?, must_change_pw = 1 WHERE id = ?').run(await hashPassword(pw), row.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
    res.json({ temp_password: pw });
  });

  // CSV columns (header row required): name, email, title, birthday, hired_on, role
  r.post('/admin/users/import', requireAdmin, async (req, res) => {
    const text = str(req.body?.csv, { max: 200000, field: 'CSV', required: true });
    const rows = parseCsv(text);
    if (rows.length < 2) throw bad('The CSV needs a header row and at least one person.');
    const head = rows[0].map((h) => h.trim().toLowerCase());
    if (!head.includes('name') || !head.includes('email')) throw bad('The header row must include name and email.');
    if (rows.length > 501) throw bad('Import up to 500 people at a time.');
    const created = [], errors = [];
    for (let i = 1; i < rows.length; i++) {
      const rec = Object.fromEntries(head.map((h, j) => [h, (rows[i][j] ?? '').trim()]));
      try {
        const f = userFields({ ...rec, role: rec.role || 'member' });
        const pw = tempPassword();
        db.prepare(
          `INSERT INTO users (email, name, title, password_hash, role, can_post, birthday, hired_on, must_change_pw, created_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, 1, ?)`
        ).run(f.email, f.name, f.title || null, await hashPassword(pw), f.role, f.birthday, f.hired_on, Date.now());
        created.push({ name: f.name, email: f.email, temp_password: pw });
      } catch (e) {
        errors.push({ line: i + 1, email: rec.email || '', error: /UNIQUE/.test(e.message || '') ? 'Email already in use.' : e.message });
      }
    }
    res.json({ created, errors });
  });

  return r;
}
