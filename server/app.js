import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { makeAuth } from './auth.js';
import { HttpError, notFound } from './util.js';
import adminRoutes from './routes/admin.js';
import bookingRoutes from './routes/bookings.js';
import supplyRoutes from './routes/supply.js';
import libraryRoutes from './routes/library.js';
import contentRoutes from './routes/content.js';
import attendanceRoutes from './routes/attendance.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ dataDir, fetchImpl = fetch, secureCookies = false, trustProxy = false } = {}) {
  const db = openDb(dataDir);
  const uploadsDir = path.join(dataDir, 'uploads'); // artwork: any signed-in user may view
  const privateDir = path.join(dataDir, 'private'); // selfies: owner and admins only
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(privateDir, { recursive: true });

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 30 } });
  const auth = makeAuth({ db, secureCookies });
  const ctx = { db, uploadsDir, privateDir, fetchImpl, upload, ...auth };

  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', 1);
  app.locals.db = db;

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(self), geolocation=(self), microphone=()',
    });
    next();
  });

  app.use(express.static(path.join(here, '..', 'public'), { index: 'index.html' }));

  app.use('/api', express.json({ limit: '200kb' }));
  app.use(['/api', '/media'], auth.loadUser);
  app.use('/api', (req, res, next) => {
    // Cookie-based sessions: refuse cross-site state changes that slip past SameSite.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      if (origin && new URL(origin).host !== req.get('host')) return next(new HttpError(403, 'Cross-site request blocked.'));
    }
    next();
  });
  app.use('/api', auth.router);

  app.get('/media/:name', auth.requireAuth, (req, res, next) => {
    if (!/^[a-f0-9]{32}\.(jpg|png|gif|webp)$/.test(req.params.name)) return next(notFound());
    res.set('Cache-Control', 'private, max-age=604800, immutable');
    res.sendFile(req.params.name, { root: uploadsDir }, (err) => err && next(notFound()));
  });

  app.use('/api', adminRoutes(ctx));
  app.use('/api', bookingRoutes(ctx));
  app.use('/api/supply', supplyRoutes(ctx));
  app.use('/api/library', libraryRoutes(ctx));
  app.use('/api', contentRoutes(ctx));
  app.use('/api/attendance', attendanceRoutes(ctx));

  app.use('/api', (req, res, next) => next(notFound('No such endpoint.')));

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'That image is too large (8 MB maximum).' });
    if (err?.name === 'MulterError') return res.status(400).json({ error: 'The upload was not understood.' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request was not valid JSON.' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'That request is too large.' });
    if (err?.code === 'ERR_SQLITE_ERROR' && /UNIQUE/.test(err.message || '')) return res.status(409).json({ error: 'That already exists.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  return { app, db, ctx };
}
