import express from 'express';
import { HttpError, bad, forbidden, notFound, str, int, oneOf, tx } from '../util.js';

const MAX_HOURS = { room: 12, parking: 24 };
const MAX_ADVANCE_MS = 180 * 24 * 3600 * 1000;
const GRACE_MS = 5 * 60 * 1000;

export default function bookingRoutes({ db, requireAuth }) {
  const r = express.Router();
  r.use(requireAuth);

  const view = `SELECT b.id, b.resource_id, b.user_id, b.start_at, b.end_at, b.title, b.party, b.guest_name, b.plate, b.notes,
                       res.name AS resource_name, res.kind, u.name AS user_name
                FROM bookings b JOIN resources res ON res.id = b.resource_id JOIN users u ON u.id = b.user_id`;

  r.get('/bookings', (req, res) => {
    const kind = oneOf(req.query.kind, ['room', 'parking'], 'kind');
    const from = int(req.query.from, { min: 0, field: 'from' });
    const to = int(req.query.to, { min: 0, field: 'to' });
    if (to - from > 62 * 24 * 3600 * 1000) throw bad('Ask for at most two months at a time.');
    const rows = db.prepare(`${view} WHERE res.kind = ? AND b.status = 'active' AND b.end_at > ? AND b.start_at < ? ORDER BY b.start_at`).all(kind, from, to);
    res.json({ bookings: rows });
  });

  r.get('/bookings/mine', (req, res) => {
    const rows = db.prepare(`${view} WHERE b.user_id = ? AND b.status = 'active' AND b.end_at > ? ORDER BY b.start_at LIMIT 100`).all(req.user.id, Date.now());
    res.json({ bookings: rows });
  });

  r.post('/bookings', (req, res) => {
    const b = req.body || {};
    const resource = db.prepare('SELECT * FROM resources WHERE id = ? AND active = 1').get(Number(b.resource_id));
    if (!resource) throw notFound('That room or slot does not exist.');
    const start = int(b.start_at, { min: 0, field: 'Start time' });
    const end = int(b.end_at, { min: 0, field: 'End time' });
    const now = Date.now();
    if (end <= start) throw bad('The end time must be after the start time.');
    if (start < now - GRACE_MS) throw bad('That start time has already passed.');
    if (start > now + MAX_ADVANCE_MS) throw bad('You can book up to 180 days ahead.');
    if (end - start > MAX_HOURS[resource.kind] * 3600 * 1000) throw bad(`A single ${resource.kind === 'room' ? 'room' : 'parking'} booking can be at most ${MAX_HOURS[resource.kind]} hours.`);

    let title = '', party = 'self', guest = '', plate = '';
    if (resource.kind === 'room') {
      title = str(b.title, { max: 120, field: 'Meeting title', required: true });
    } else {
      party = oneOf(b.party || 'self', ['self', 'vip', 'guest'], 'Who is the slot for');
      if (party !== 'self') guest = str(b.guest_name, { max: 80, field: party === 'vip' ? 'VIP name' : 'Guest name', required: true });
      plate = str(b.plate, { max: 16, field: 'Plate number' }).toUpperCase();
      title = party === 'self' ? 'Parking' : party === 'vip' ? `VIP: ${guest}` : `Guest: ${guest}`;
    }
    const notes = str(b.notes, { max: 300, field: 'Notes' });

    // The check and the insert happen inside one IMMEDIATE transaction, so two people clicking at the same time cannot both win.
    const id = tx(db, () => {
      const clash = db.prepare(
        `SELECT b.start_at, b.end_at, b.title, u.name AS user_name FROM bookings b JOIN users u ON u.id = b.user_id
         WHERE b.resource_id = ? AND b.status = 'active' AND b.start_at < ? AND b.end_at > ? ORDER BY b.start_at LIMIT 1`
      ).get(resource.id, end, start);
      if (clash) {
        throw new HttpError(409, `${resource.name} is already booked by ${clash.user_name} at that time.`, { conflict: clash });
      }
      const info = db.prepare(
        `INSERT INTO bookings (resource_id, user_id, start_at, end_at, title, party, guest_name, plate, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(resource.id, req.user.id, start, end, title, party, guest || null, plate || null, notes || null, now);
      return Number(info.lastInsertRowid);
    });
    res.status(201).json({ id });
  });

  r.delete('/bookings/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
    if (!row || row.status !== 'active') throw notFound('That booking was not found.');
    if (row.user_id !== req.user.id && !req.user.is_admin) throw forbidden('Only the person who booked it, or an admin, can cancel it.');
    if (row.end_at < Date.now() && !req.user.is_admin) throw bad('That booking is already over.');
    db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(row.id);
    res.json({ ok: true });
  });

  return r;
}
