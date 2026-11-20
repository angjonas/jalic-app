import express from 'express';
import { getSettings } from '../db.js';
import { HttpError, bad, forbidden, notFound, num, int, saveImage, haversineM, csvEscape, localStamp, todayIn } from '../util.js';

const DAY = 24 * 3600 * 1000;
const STALE_IN_MS = 18 * 3600 * 1000; // an "in" older than this with no "out" is treated as a forgotten clock-out

// Start of a calendar day (YYYY-MM-DD) in a timezone, as epoch ms.
function dayStartMs(dateStr, tz) {
  const guess = Date.parse(dateStr + 'T00:00:00Z');
  const asLocal = Date.parse(new Date(guess).toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T') + 'Z');
  return guess - (asLocal - guess);
}

export function geofenceCheck(settings, { lat, lng, accuracy }) {
  if (settings.geo_lat === '' || settings.geo_lng === '') {
    throw new HttpError(409, 'Attendance is not set up yet. Ask an admin to set the office location.', { code: 'geofence_not_configured' });
  }
  const radius = Number(settings.geo_radius_m);
  const maxAcc = Number(settings.geo_max_accuracy_m);
  if (accuracy > maxAcc) {
    throw new HttpError(422, `Your location is too imprecise (about ${Math.round(accuracy)} m off, limit ${Math.round(maxAcc)} m). Step outside or near a window, wait a few seconds, then try again.`, { code: 'low_accuracy', accuracy_m: accuracy });
  }
  const distance = haversineM(Number(settings.geo_lat), Number(settings.geo_lng), lat, lng);
  if (distance > radius) {
    throw new HttpError(403, `You are about ${Math.round(distance)} m from the office. You need to be within ${Math.round(radius)} m to clock in or out.`, { code: 'outside_geofence', distance_m: Math.round(distance), radius_m: radius });
  }
  return distance;
}

export default function attendanceRoutes({ db, requireAuth, requireAdmin, upload, privateDir }) {
  const r = express.Router();
  r.use(requireAuth);

  function nextKind(userId, now = Date.now()) {
    const last = db.prepare('SELECT kind, at_ms FROM attendance WHERE user_id = ? ORDER BY at_ms DESC, id DESC LIMIT 1').get(userId);
    if (!last) return { next: 'in', last: null };
    if (last.kind === 'in' && now - last.at_ms > STALE_IN_MS) return { next: 'in', last, missed_out: true };
    return { next: last.kind === 'in' ? 'out' : 'in', last };
  }

  r.get('/status', (req, res) => {
    const s = getSettings(db);
    const n = nextKind(req.user.id);
    res.json({
      next: n.next, last: n.last, missed_out: !!n.missed_out,
      geofence_configured: s.geo_lat !== '' && s.geo_lng !== '',
      radius_m: Number(s.geo_radius_m), max_accuracy_m: Number(s.geo_max_accuracy_m),
      server_time: Date.now(),
    });
  });

  r.post('/', upload.single('selfie'), (req, res) => {
    const s = getSettings(db);
    const b = req.body || {};
    const lat = num(b.lat, { min: -90, max: 90, field: 'Latitude' });
    const lng = num(b.lng, { min: -180, max: 180, field: 'Longitude' });
    const accuracy = num(b.accuracy, { min: 0, max: 100000, field: 'GPS accuracy' });
    if (!req.file) throw bad('A selfie is required to record attendance.');
    const distance = geofenceCheck(s, { lat, lng, accuracy });
    const photo = saveImage(req.file.buffer, privateDir);
    const now = Date.now(); // the server's clock is the only clock that counts
    const { next } = nextKind(req.user.id, now);
    const info = db.prepare('INSERT INTO attendance (user_id, kind, at_ms, lat, lng, accuracy_m, distance_m, photo, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.user.id, next, now, lat, lng, accuracy, distance, photo, String(req.get('user-agent') || '').slice(0, 200));
    res.status(201).json({ id: Number(info.lastInsertRowid), kind: next, at_ms: now, distance_m: Math.round(distance) });
  });

  const rowSql = `SELECT a.id, a.user_id, u.name AS user_name, a.kind, a.at_ms, a.accuracy_m, a.distance_m FROM attendance a JOIN users u ON u.id = a.user_id`;

  r.get('/mine', (req, res) => {
    const rows = db.prepare(`${rowSql} WHERE a.user_id = ? ORDER BY a.at_ms DESC LIMIT 60`).all(req.user.id);
    res.json({ records: rows });
  });

  // Admin: who is in right now / today's log
  r.get('/today', requireAdmin, (req, res) => {
    const tz = getSettings(db).timezone;
    const start = dayStartMs(todayIn(tz), tz);
    const rows = db.prepare(`${rowSql} WHERE a.at_ms >= ? AND a.at_ms < ? ORDER BY a.at_ms`).all(start, start + DAY);
    const state = new Map();
    for (const x of rows) state.set(x.user_id, x);
    const people = db.prepare('SELECT id, name FROM users WHERE active = 1 ORDER BY name COLLATE NOCASE').all().map((p) => {
      const last = state.get(p.id);
      const first = rows.find((x) => x.user_id === p.id && x.kind === 'in');
      return { user_id: p.id, name: p.name, status: !last ? 'absent' : last.kind === 'in' ? 'in' : 'out', first_in: first?.at_ms ?? null, last_at: last?.at_ms ?? null, last_id: last?.id ?? null };
    });
    res.json({ people, records: rows });
  });

  function range(req) {
    const tz = getSettings(db).timezone;
    const from = req.query.from ? dayStartMs(String(req.query.from), tz) : dayStartMs(todayIn(tz), tz) - 6 * DAY;
    const to = req.query.to ? dayStartMs(String(req.query.to), tz) + DAY : dayStartMs(todayIn(tz), tz) + DAY;
    if (!(to > from) || to - from > 93 * DAY) throw bad('Choose a date range of up to three months.');
    return { from, to, tz };
  }

  r.get('/report', requireAdmin, (req, res) => {
    const { from, to } = range(req);
    const uid = int(req.query.user_id, { min: 1, field: 'user', required: false });
    const rows = db.prepare(`${rowSql} WHERE a.at_ms >= ? AND a.at_ms < ? ${uid ? 'AND a.user_id = ?' : ''} ORDER BY a.at_ms DESC LIMIT 2000`)
      .all(...(uid ? [from, to, uid] : [from, to]));
    res.json({ records: rows });
  });

  r.get('/export.csv', requireAdmin, (req, res) => {
    const { from, to, tz } = range(req);
    const rows = db.prepare(
      `SELECT u.name, u.email, a.kind, a.at_ms, a.distance_m, a.accuracy_m, a.lat, a.lng
       FROM attendance a JOIN users u ON u.id = a.user_id WHERE a.at_ms >= ? AND a.at_ms < ? ORDER BY u.name COLLATE NOCASE, a.at_ms`
    ).all(from, to);
    const lines = [['Name', 'Email', 'Type', `Time (${tz})`, 'Distance from office (m)', 'GPS accuracy (m)', 'Latitude', 'Longitude'].join(',')];
    for (const x of rows) {
      lines.push([x.name, x.email, x.kind === 'in' ? 'Clock in' : 'Clock out', localStamp(x.at_ms, tz), Math.round(x.distance_m), Math.round(x.accuracy_m), x.lat, x.lng].map(csvEscape).join(','));
    }
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="attendance.csv"' });
    res.send('﻿' + lines.join('\r\n') + '\r\n');
  });

  r.get('/:id/photo', (req, res, next) => {
    const row = db.prepare('SELECT user_id, photo FROM attendance WHERE id = ?').get(req.params.id);
    if (!row) throw notFound();
    if (row.user_id !== req.user.id && !req.user.is_admin) throw forbidden();
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(row.photo, { root: privateDir }, (err) => err && next(notFound()));
  });

  return r;
}
