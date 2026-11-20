import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || {};
  }
}
export const bad = (m, extra) => new HttpError(400, m, extra);
export const forbidden = (m = 'You do not have permission to do that.') => new HttpError(403, m);
export const notFound = (m = 'Not found.') => new HttpError(404, m);

export function str(v, { max = 200, field = 'Value', required = false } = {}) {
  if (v == null || v === '') {
    if (required) throw bad(`${field} is required.`);
    return '';
  }
  if (typeof v !== 'string') throw bad(`${field} must be text.`);
  const s = v.trim();
  if (required && !s) throw bad(`${field} is required.`);
  if (s.length > max) throw bad(`${field} is too long (max ${max} characters).`);
  return s;
}

export function int(v, { min = -Infinity, max = Infinity, field = 'Value', required = true } = {}) {
  if (v == null || v === '') {
    if (required) throw bad(`${field} is required.`);
    return null;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${field} must be a whole number between ${min} and ${max}.`);
  return n;
}

export function num(v, { min = -Infinity, max = Infinity, field = 'Value', required = true } = {}) {
  if (v == null || v === '') {
    if (required) throw bad(`${field} is required.`);
    return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${field} must be a number between ${min} and ${max}.`);
  return n;
}

export function oneOf(v, list, field = 'Value') {
  if (!list.includes(v)) throw bad(`${field} must be one of: ${list.join(', ')}.`);
  return v;
}

export function dateStr(v, field = 'Date', required = false) {
  if (v == null || v === '') {
    if (required) throw bad(`${field} is required.`);
    return null;
  }
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad(`${field} must look like 2026-12-25.`);
  const d = new Date(v + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw bad(`${field} is not a real date.`);
  return v;
}

// Accepts MM-DD or YYYY-MM-DD, stores MM-DD.
export function birthday(v) {
  if (v == null || v === '') return null;
  const m = /^(?:\d{4}-)?(\d{2})-(\d{2})$/.exec(String(v).trim());
  if (!m) throw bad('Birthday must look like 03-14 or 1990-03-14.');
  const mm = Number(m[1]), dd = Number(m[2]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) throw bad('Birthday is not a real date.');
  return `${m[1]}-${m[2]}`;
}

export function detectImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

export function saveImage(buf, dir) {
  const ext = detectImage(buf);
  if (!ext) throw bad('That file is not a supported image. Use JPG, PNG, WebP or GIF.');
  fs.mkdirSync(dir, { recursive: true });
  const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(dir, name), buf);
  return name;
}

export function removeFile(dir, name) {
  if (!name || !/^[a-f0-9]{32}\.(jpg|png|gif|webp)$/.test(name)) return;
  try { fs.unlinkSync(path.join(dir, name)); } catch { /* already gone */ }
}

export function csvEscape(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // spreadsheet formula injection guard
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

const PW_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function tempPassword(len = 10) {
  let s = '';
  for (let i = 0; i < len; i++) s += PW_ALPHABET[crypto.randomInt(PW_ALPHABET.length)];
  return s;
}

// Today's date (YYYY-MM-DD) in a given IANA timezone.
export function todayIn(tz, at = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
}

export function localStamp(ms, tz) {
  return new Date(ms).toLocaleString('sv-SE', { timeZone: tz });
}

// Days until the next MM-DD on or after `today` (YYYY-MM-DD). Returns { diff, year } or null.
export function daysUntil(md, today) {
  const [ty, tm, td] = today.split('-').map(Number);
  const [m, d] = md.split('-').map(Number);
  const t0 = Date.UTC(ty, tm - 1, td);
  for (const y of [ty, ty + 1, ty + 2, ty + 3, ty + 4]) {
    const t = Date.UTC(y, m - 1, d);
    if (new Date(t).getUTCMonth() !== m - 1) continue; // Feb 29 in a non-leap year
    const diff = Math.round((t - t0) / 864e5);
    if (diff >= 0) return { diff, year: y };
  }
  return null;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

export function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371008.8;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
