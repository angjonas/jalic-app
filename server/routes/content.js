import express from 'express';
import { getSettings } from '../db.js';
import { bad, forbidden, notFound, str, int, num, oneOf, saveImage, removeFile, todayIn, daysUntil } from '../util.js';

const DAY = 24 * 3600 * 1000;
const CATEGORIES = ['holiday', 'birthday', 'anniversary', 'promotion', 'equipment', 'repair', 'general'];

export default function contentRoutes({ db, requireAuth, requirePoster, upload, uploadsDir }) {
  const r = express.Router();
  r.use(requireAuth);

  const mayEdit = (req, row) => req.user.is_admin || row.created_by === req.user.id;
  const need = (row) => { if (!row) throw notFound(); return row; };
  const checkOwner = (req, row) => { if (!mayEdit(req, row)) throw forbidden('Only the person who posted this, or an admin, can change it.'); };
  const newImage = (req, old) => {
    if (req.file) return { image: saveImage(req.file.buffer, uploadsDir), replaced: old };
    if (req.body?.remove_image === '1' || req.body?.remove_image === true) return { image: null, replaced: old };
    return { image: old, replaced: null };
  };

  // ---------------- Events ----------------
  r.get('/events', (req, res) => {
    const rows = db.prepare(
      `SELECT e.id, e.title, e.description, e.location, e.starts_at, e.ends_at, e.image, e.created_by, u.name AS created_by_name,
              (SELECT COUNT(*) FROM event_rsvps s WHERE s.event_id = e.id) AS going_count,
              EXISTS (SELECT 1 FROM event_rsvps s WHERE s.event_id = e.id AND s.user_id = ?) AS i_going
       FROM events e JOIN users u ON u.id = e.created_by
       WHERE COALESCE(e.ends_at, e.starts_at) > ? ORDER BY e.starts_at LIMIT 200`
    ).all(req.user.id, Date.now() - 14 * DAY);
    res.json({ events: rows.map((x) => ({ ...x, i_going: !!x.i_going })) });
  });

  function eventFields(b, row = {}) {
    const starts = b.starts_at !== undefined ? int(b.starts_at, { min: 0, field: 'Start time' }) : row.starts_at;
    const endsRaw = b.ends_at !== undefined ? int(b.ends_at, { min: 0, field: 'End time', required: false }) : row.ends_at;
    if (endsRaw != null && endsRaw <= starts) throw bad('The event must end after it starts.');
    return {
      title: b.title !== undefined ? str(b.title, { max: 120, field: 'Title', required: true }) : row.title,
      description: b.description !== undefined ? str(b.description, { max: 2000, field: 'Details' }) : row.description,
      location: b.location !== undefined ? str(b.location, { max: 120, field: 'Where' }) : row.location,
      starts_at: starts, ends_at: endsRaw ?? null,
    };
  }
  r.post('/events', requirePoster, upload.single('image'), (req, res) => {
    const f = eventFields(req.body || {});
    const info = db.prepare('INSERT INTO events (title, description, location, starts_at, ends_at, image, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(f.title, f.description || null, f.location || null, f.starts_at, f.ends_at, req.file ? saveImage(req.file.buffer, uploadsDir) : null, req.user.id, Date.now());
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });
  r.patch('/events/:id', upload.single('image'), (req, res) => {
    const row = need(db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id));
    checkOwner(req, row);
    const f = eventFields(req.body || {}, row);
    const { image, replaced } = newImage(req, row.image);
    db.prepare('UPDATE events SET title=?, description=?, location=?, starts_at=?, ends_at=?, image=? WHERE id=?')
      .run(f.title, f.description || null, f.location || null, f.starts_at, f.ends_at, image, row.id);
    removeFile(uploadsDir, replaced);
    res.json({ ok: true });
  });
  r.delete('/events/:id', (req, res) => {
    const row = need(db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id));
    checkOwner(req, row);
    db.prepare('DELETE FROM events WHERE id = ?').run(row.id);
    removeFile(uploadsDir, row.image);
    res.json({ ok: true });
  });
  r.post('/events/:id/rsvp', (req, res) => {
    const row = need(db.prepare('SELECT id FROM events WHERE id = ?').get(req.params.id));
    const has = db.prepare('SELECT 1 FROM event_rsvps WHERE event_id = ? AND user_id = ?').get(row.id, req.user.id);
    if (has) db.prepare('DELETE FROM event_rsvps WHERE event_id = ? AND user_id = ?').run(row.id, req.user.id);
    else db.prepare('INSERT INTO event_rsvps (event_id, user_id) VALUES (?, ?)').run(row.id, req.user.id);
    res.json({ i_going: !has });
  });

  // ---------------- Promos ----------------
  r.get('/promos', (req, res) => {
    const rows = db.prepare(
      `SELECT p.id, p.brand, p.title, p.description, p.price, p.original_price, p.valid_until, p.how_to_buy, p.image, p.created_by, u.name AS created_by_name,
              (SELECT COUNT(*) FROM promo_interest i WHERE i.promo_id = p.id) AS interest_count,
              EXISTS (SELECT 1 FROM promo_interest i WHERE i.promo_id = p.id AND i.user_id = ?) AS i_interested
       FROM promos p JOIN users u ON u.id = p.created_by
       WHERE p.valid_until IS NULL OR p.valid_until > ? ORDER BY p.created_at DESC LIMIT 200`
    ).all(req.user.id, Date.now() - 14 * DAY);
    res.json({ promos: rows.map((x) => ({ ...x, i_interested: !!x.i_interested })) });
  });

  function promoFields(b, row = {}) {
    const price = b.price !== undefined ? num(b.price, { min: 0, max: 10000000, field: 'Price' }) : row.price;
    const orig = b.original_price !== undefined ? num(b.original_price, { min: 0, max: 10000000, field: 'Regular price', required: false }) : row.original_price;
    if (orig != null && orig < price) throw bad('The regular price should be higher than the promo price.');
    return {
      brand: b.brand !== undefined ? str(b.brand, { max: 60, field: 'Brand', required: true }) : row.brand,
      title: b.title !== undefined ? str(b.title, { max: 120, field: 'Product', required: true }) : row.title,
      description: b.description !== undefined ? str(b.description, { max: 1000, field: 'Details' }) : row.description,
      price, original_price: orig ?? null,
      valid_until: b.valid_until !== undefined ? int(b.valid_until, { min: 0, field: 'Valid until', required: false }) : row.valid_until,
      how_to_buy: b.how_to_buy !== undefined ? str(b.how_to_buy, { max: 300, field: 'How to buy' }) : row.how_to_buy,
    };
  }
  r.post('/promos', requirePoster, upload.single('image'), (req, res) => {
    const f = promoFields(req.body || {});
    const info = db.prepare('INSERT INTO promos (brand, title, description, price, original_price, valid_until, how_to_buy, image, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(f.brand, f.title, f.description || null, f.price, f.original_price, f.valid_until ?? null, f.how_to_buy || null, req.file ? saveImage(req.file.buffer, uploadsDir) : null, req.user.id, Date.now());
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });
  r.patch('/promos/:id', upload.single('image'), (req, res) => {
    const row = need(db.prepare('SELECT * FROM promos WHERE id = ?').get(req.params.id));
    checkOwner(req, row);
    const f = promoFields(req.body || {}, row);
    const { image, replaced } = newImage(req, row.image);
    db.prepare('UPDATE promos SET brand=?, title=?, description=?, price=?, original_price=?, valid_until=?, how_to_buy=?, image=? WHERE id=?')
      .run(f.brand, f.title, f.description || null, f.price, f.original_price, f.valid_until ?? null, f.how_to_buy || null, image, row.id);
    removeFile(uploadsDir, replaced);
    res.json({ ok: true });
  });
  r.delete('/promos/:id', (req, res) => {
    const row = need(db.prepare('SELECT * FROM promos WHERE id = ?').get(req.params.id));
    checkOwner(req, row);
    db.prepare('DELETE FROM promos WHERE id = ?').run(row.id);
    removeFile(uploadsDir, row.image);
    res.json({ ok: true });
  });
  r.post('/promos/:id/interest', (req, res) => {
    const row = need(db.prepare('SELECT id FROM promos WHERE id = ?').get(req.params.id));
    const has = db.prepare('SELECT 1 FROM promo_interest WHERE promo_id = ? AND user_id = ?').get(row.id, req.user.id);
    if (has) db.prepare('DELETE FROM promo_interest WHERE promo_id = ? AND user_id = ?').run(row.id, req.user.id);
    else db.prepare('INSERT INTO promo_interest (promo_id, user_id) VALUES (?, ?)').run(row.id, req.user.id);
    res.json({ i_interested: !has });
  });

  // ---------------- Community Board ----------------
  r.get('/board', (req, res) => {
    const posts = db.prepare(
      `SELECT p.id, p.category, p.title, p.body, p.image, p.pinned, p.expires_at, p.created_by, p.created_at, u.name AS created_by_name
       FROM posts p JOIN users u ON u.id = p.created_by
       WHERE p.expires_at IS NULL OR p.expires_at > ? ORDER BY p.pinned DESC, p.created_at DESC LIMIT 100`
    ).all(Date.now()).map((x) => ({ ...x, pinned: !!x.pinned }));

    const tz = getSettings(db).timezone;
    const today = todayIn(tz);
    const birthdays = [], anniversaries = [];
    for (const u of db.prepare('SELECT id, name, birthday, hired_on FROM users WHERE active = 1').all()) {
      if (u.birthday) {
        const d = daysUntil(u.birthday, today);
        if (d && d.diff <= 14) birthdays.push({ user_id: u.id, name: u.name, month_day: u.birthday, days_away: d.diff });
      }
      if (u.hired_on) {
        const d = daysUntil(u.hired_on.slice(5), today);
        const years = d ? d.year - Number(u.hired_on.slice(0, 4)) : 0;
        if (d && d.diff <= 14 && years >= 1) anniversaries.push({ user_id: u.id, name: u.name, month_day: u.hired_on.slice(5), years, days_away: d.diff });
      }
    }
    const byDay = (a, b) => a.days_away - b.days_away || a.name.localeCompare(b.name);
    res.json({ posts, birthdays: birthdays.sort(byDay), anniversaries: anniversaries.sort(byDay), today });
  });

  function postFields(b, row = {}) {
    return {
      category: b.category !== undefined ? oneOf(b.category, CATEGORIES, 'Category') : row.category,
      title: b.title !== undefined ? str(b.title, { max: 140, field: 'Headline', required: true }) : row.title,
      body: b.body !== undefined ? str(b.body, { max: 4000, field: 'Message' }) : row.body,
      pinned: b.pinned !== undefined ? (b.pinned === true || b.pinned === '1' || b.pinned === 'true' ? 1 : 0) : row.pinned,
      expires_at: b.expires_at !== undefined ? int(b.expires_at, { min: 0, field: 'Hide after', required: false }) : row.expires_at,
    };
  }
  r.post('/board', requirePoster, upload.single('image'), (req, res) => {
    const f = postFields(req.body || {});
    if (!f.category) throw bad('Category is required.');
    const info = db.prepare('INSERT INTO posts (category, title, body, image, pinned, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(f.category, f.title, f.body || null, req.file ? saveImage(req.file.buffer, uploadsDir) : null, f.pinned || 0, f.expires_at ?? null, req.user.id, Date.now());
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });
  r.patch('/board/:id', upload.single('image'), (req, res) => {
    const row = need(db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id));
    checkOwner(req, row);
    const f = postFields(req.body || {}, row);
    const { image, replaced } = newImage(req, row.image);
    db.prepare('UPDATE posts SET category=?, title=?, body=?, image=?, pinned=?, expires_at=? WHERE id=?')
      .run(f.category, f.title, f.body || null, image, f.pinned || 0, f.expires_at ?? null, row.id);
    removeFile(uploadsDir, replaced);
    res.json({ ok: true });
  });
  r.delete('/board/:id', (req, res) => {
    const row = need(db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id));
    checkOwner(req, row);
    db.prepare('DELETE FROM posts WHERE id = ?').run(row.id);
    removeFile(uploadsDir, row.image);
    res.json({ ok: true });
  });

  return r;
}
