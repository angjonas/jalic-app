import express from 'express';
import { HttpError, bad, notFound, str, int, oneOf, saveImage, removeFile, detectImage, tx } from '../util.js';
import { searchCovers, downloadImage } from '../covers.js';

const KINDS = ['book', 'boardgame', 'console', 'other'];
const DEFAULT_DAYS = { book: 21, boardgame: 7, console: 7, other: 7 };
const MAX_OPEN_LOANS = 5;
const DAY = 24 * 3600 * 1000;

export default function libraryRoutes({ db, requireAuth, requireAdmin, upload, uploadsDir, fetchImpl }) {
  const r = express.Router();
  r.use(requireAuth);

  const listSql = `
    SELECT i.id, i.kind, i.title, i.creator, i.description, i.cover,
           l.id AS loan_id, l.user_id AS borrower_id, l.borrowed_at, l.due_at, u.name AS borrower_name
    FROM library_items i
    LEFT JOIN loans l ON l.item_id = i.id AND l.returned_at IS NULL
    LEFT JOIN users u ON u.id = l.user_id
    WHERE i.active = 1`;

  r.get('/', (req, res) => {
    const rows = db.prepare(listSql + ' ORDER BY i.title COLLATE NOCASE').all();
    res.json({
      items: rows.map((x) => ({
        id: x.id, kind: x.kind, title: x.title, creator: x.creator, description: x.description, cover: x.cover,
        loan: x.loan_id ? { id: x.loan_id, user_id: x.borrower_id, user_name: x.borrower_name, borrowed_at: x.borrowed_at, due_at: x.due_at } : null,
      })),
    });
  });

  r.get('/cover-search', requireAdmin, async (req, res) => {
    const kind = oneOf(req.query.kind || 'other', KINDS, 'kind');
    try {
      res.json({ results: await searchCovers(kind, req.query.q, fetchImpl) });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      res.status(502).json({ error: 'Could not reach the cover art sources right now. You can upload a photo instead.' });
    }
  });

  // Thumbnails for the cover picker are fetched by the server, so staff browsers never contact third-party sites.
  r.get('/cover-preview', requireAdmin, async (req, res) => {
    try {
      const buf = await downloadImage(String(req.query.url || ''), fetchImpl);
      res.set({ 'Content-Type': 'image/' + (detectImage(buf) === 'jpg' ? 'jpeg' : detectImage(buf)), 'Cache-Control': 'private, max-age=86400' });
      res.send(buf);
    } catch {
      res.status(404).end();
    }
  });

  async function readCover(req, existing) {
    if (req.file) return { cover: saveImage(req.file.buffer, uploadsDir) };
    const url = str(req.body?.cover_url, { max: 500, field: 'Cover link' });
    if (!url) return { cover: existing };
    try {
      return { cover: saveImage(await downloadImage(url, fetchImpl), uploadsDir) };
    } catch (e) {
      return { cover: existing, cover_error: e.message };
    }
  }

  r.post('/', requireAdmin, upload.single('image'), async (req, res) => {
    const b = req.body || {};
    const kind = oneOf(b.kind, KINDS, 'Type');
    const title = str(b.title, { max: 120, field: 'Title', required: true });
    const creator = str(b.creator, { max: 120, field: 'Author or maker' });
    const description = str(b.description, { max: 600, field: 'Description' });
    const { cover, cover_error } = await readCover(req, null);
    const info = db.prepare('INSERT INTO library_items (kind, title, creator, description, cover, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(kind, title, creator || null, description || null, cover, Date.now());
    res.status(201).json({ id: Number(info.lastInsertRowid), cover_error: cover_error || null });
  });

  r.patch('/:id', requireAdmin, upload.single('image'), async (req, res) => {
    const row = db.prepare('SELECT * FROM library_items WHERE id = ? AND active = 1').get(req.params.id);
    if (!row) throw notFound();
    const b = req.body || {};
    const kind = b.kind !== undefined ? oneOf(b.kind, KINDS, 'Type') : row.kind;
    const title = b.title !== undefined ? str(b.title, { max: 120, field: 'Title', required: true }) : row.title;
    const creator = b.creator !== undefined ? str(b.creator, { max: 120 }) : row.creator;
    const description = b.description !== undefined ? str(b.description, { max: 600 }) : row.description;
    const { cover, cover_error } = await readCover(req, row.cover);
    db.prepare('UPDATE library_items SET kind=?, title=?, creator=?, description=?, cover=? WHERE id=?')
      .run(kind, title, creator || null, description || null, cover, row.id);
    if (cover !== row.cover) removeFile(uploadsDir, row.cover);
    res.json({ ok: true, cover_error: cover_error || null });
  });

  r.delete('/:id', requireAdmin, (req, res) => {
    const row = db.prepare('SELECT * FROM library_items WHERE id = ?').get(req.params.id);
    if (!row) throw notFound();
    if (db.prepare('SELECT 1 FROM loans WHERE item_id = ? AND returned_at IS NULL').get(row.id)) throw bad('That item is on loan. Mark it returned first.');
    db.prepare('UPDATE library_items SET active = 0 WHERE id = ?').run(row.id);
    res.json({ ok: true });
  });

  r.post('/:id/borrow', (req, res) => {
    const item = db.prepare('SELECT * FROM library_items WHERE id = ? AND active = 1').get(req.params.id);
    if (!item) throw notFound();
    const days = int(req.body?.days ?? DEFAULT_DAYS[item.kind], { min: 1, max: 30, field: 'Loan length' });
    const now = Date.now();
    tx(db, () => {
      const open = db.prepare('SELECT COUNT(*) AS n FROM loans WHERE user_id = ? AND returned_at IS NULL').get(req.user.id).n;
      if (open >= MAX_OPEN_LOANS) throw bad(`You already have ${MAX_OPEN_LOANS} items out. Return one first.`);
      const taken = db.prepare('SELECT u.name FROM loans l JOIN users u ON u.id = l.user_id WHERE l.item_id = ? AND l.returned_at IS NULL').get(item.id);
      if (taken) throw new HttpError(409, `${taken.name} has this one right now.`);
      db.prepare('INSERT INTO loans (item_id, user_id, borrowed_at, due_at) VALUES (?, ?, ?, ?)').run(item.id, req.user.id, now, now + days * DAY);
    });
    res.status(201).json({ ok: true, due_at: now + days * DAY });
  });

  r.post('/:id/return', (req, res) => {
    const loan = db.prepare('SELECT * FROM loans WHERE item_id = ? AND returned_at IS NULL').get(req.params.id);
    if (!loan) throw bad('That item is not on loan.');
    if (loan.user_id !== req.user.id && !req.user.is_admin) throw bad('Only the borrower or an admin can mark it returned.');
    db.prepare('UPDATE loans SET returned_at = ? WHERE id = ?').run(Date.now(), loan.id);
    res.json({ ok: true });
  });

  return r;
}
