import express from 'express';
import { bad, forbidden, notFound, str, int, oneOf } from '../util.js';

export default function supplyRoutes({ db, requireAuth, requireAdmin }) {
  const r = express.Router();
  r.use(requireAuth);

  r.get('/catalog', (req, res) => {
    res.json({ items: db.prepare('SELECT id, category, name, unit FROM supply_catalog WHERE active = 1 ORDER BY category, name').all() });
  });
  r.post('/catalog', requireAdmin, (req, res) => {
    const b = req.body || {};
    const name = str(b.name, { max: 80, field: 'Item name', required: true });
    const category = str(b.category, { max: 40, field: 'Category', required: true });
    const unit = str(b.unit, { max: 20, field: 'Unit', required: true });
    db.prepare(
      'INSERT INTO supply_catalog (category, name, unit) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET category = excluded.category, unit = excluded.unit, active = 1'
    ).run(category, name, unit);
    res.status(201).json({ ok: true });
  });
  r.delete('/catalog/:id', requireAdmin, (req, res) => {
    db.prepare('UPDATE supply_catalog SET active = 0 WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  r.get('/requests', (req, res) => {
    const rows = db.prepare(
      `SELECT q.id, q.user_id, q.item, q.unit, q.qty, q.urgency, q.note, q.status, q.status_note, q.created_at, q.updated_at, u.name AS user_name,
              (SELECT COUNT(*) FROM supply_metoo m WHERE m.request_id = q.id) AS metoo_count,
              EXISTS (SELECT 1 FROM supply_metoo m WHERE m.request_id = q.id AND m.user_id = ?) AS i_metoo
       FROM supply_requests q JOIN users u ON u.id = q.user_id
       WHERE q.status IN ('requested','ordered') OR q.updated_at > ?
       ORDER BY q.created_at DESC LIMIT 500`
    ).all(req.user.id, Date.now() - 60 * 24 * 3600 * 1000);
    res.json({ requests: rows.map((x) => ({ ...x, i_metoo: !!x.i_metoo })) });
  });

  r.post('/requests', (req, res) => {
    const b = req.body || {};
    const item = str(b.item, { max: 80, field: 'Item', required: true });
    const unit = str(b.unit, { max: 20, field: 'Unit' }) || 'pcs';
    const qty = int(b.qty ?? 1, { min: 1, max: 999, field: 'Quantity' });
    const urgency = oneOf(b.urgency || 'normal', ['normal', 'low', 'out'], 'Urgency');
    const note = str(b.note, { max: 300, field: 'Note' });
    const now = Date.now();
    const info = db.prepare(
      'INSERT INTO supply_requests (user_id, item, unit, qty, urgency, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(req.user.id, item, unit, qty, urgency, note || null, now, now);
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });

  r.post('/requests/:id/metoo', (req, res) => {
    const q = db.prepare('SELECT * FROM supply_requests WHERE id = ?').get(req.params.id);
    if (!q) throw notFound();
    if (q.user_id === req.user.id) throw bad('That is your own request.');
    if (!['requested', 'ordered'].includes(q.status)) throw bad('That request is closed.');
    const has = db.prepare('SELECT 1 FROM supply_metoo WHERE request_id = ? AND user_id = ?').get(q.id, req.user.id);
    if (has) db.prepare('DELETE FROM supply_metoo WHERE request_id = ? AND user_id = ?').run(q.id, req.user.id);
    else db.prepare('INSERT INTO supply_metoo (request_id, user_id) VALUES (?, ?)').run(q.id, req.user.id);
    res.json({ i_metoo: !has });
  });

  r.patch('/requests/:id', requireAdmin, (req, res) => {
    const q = db.prepare('SELECT * FROM supply_requests WHERE id = ?').get(req.params.id);
    if (!q) throw notFound();
    const status = oneOf(req.body?.status, ['requested', 'ordered', 'restocked', 'declined'], 'Status');
    const note = req.body?.status_note !== undefined ? str(req.body.status_note, { max: 200, field: 'Note' }) : q.status_note;
    db.prepare('UPDATE supply_requests SET status = ?, status_note = ?, updated_at = ? WHERE id = ?').run(status, note || null, Date.now(), q.id);
    res.json({ ok: true });
  });

  r.delete('/requests/:id', (req, res) => {
    const q = db.prepare('SELECT * FROM supply_requests WHERE id = ?').get(req.params.id);
    if (!q) throw notFound();
    const mine = q.user_id === req.user.id && q.status === 'requested';
    if (!mine && !req.user.is_admin) throw forbidden('You can only cancel your own request while it is still waiting.');
    db.prepare('DELETE FROM supply_requests WHERE id = ?').run(q.id);
    res.json({ ok: true });
  });

  return r;
}
