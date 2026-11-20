import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  title TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  can_post INTEGER NOT NULL DEFAULT 0,
  birthday TEXT,
  hired_on TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  must_change_pw INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS resources (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('room','parking')),
  name TEXT NOT NULL,
  detail TEXT,
  capacity INTEGER,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  resource_id INTEGER NOT NULL REFERENCES resources(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  title TEXT,
  party TEXT NOT NULL DEFAULT 'self' CHECK (party IN ('self','vip','guest')),
  guest_name TEXT,
  plate TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_at INTEGER NOT NULL,
  CHECK (end_at > start_at)
);
CREATE INDEX IF NOT EXISTS bookings_lookup ON bookings(resource_id, start_at, end_at) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS supply_catalog (
  id INTEGER PRIMARY KEY,
  category TEXT NOT NULL,
  name TEXT NOT NULL UNIQUE,
  unit TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS supply_requests (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  item TEXT NOT NULL,
  unit TEXT NOT NULL,
  qty INTEGER NOT NULL,
  urgency TEXT NOT NULL DEFAULT 'normal' CHECK (urgency IN ('normal','low','out')),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','ordered','restocked','declined')),
  status_note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS supply_metoo (
  request_id INTEGER NOT NULL REFERENCES supply_requests(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (request_id, user_id)
);

CREATE TABLE IF NOT EXISTS library_items (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('book','boardgame','console','other')),
  title TEXT NOT NULL,
  creator TEXT,
  description TEXT,
  cover TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES library_items(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  borrowed_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  returned_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS loans_one_open ON loans(item_id) WHERE returned_at IS NULL;

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER,
  image TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS event_rsvps (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (event_id, user_id)
);

CREATE TABLE IF NOT EXISTS promos (
  id INTEGER PRIMARY KEY,
  brand TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  price REAL NOT NULL,
  original_price REAL,
  valid_until INTEGER,
  how_to_buy TEXT,
  image TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS promo_interest (
  promo_id INTEGER NOT NULL REFERENCES promos(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (promo_id, user_id)
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('holiday','birthday','anniversary','promotion','equipment','repair','general')),
  title TEXT NOT NULL,
  body TEXT,
  image TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('in','out')),
  at_ms INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  accuracy_m REAL NOT NULL,
  distance_m REAL NOT NULL,
  photo TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS attendance_user_time ON attendance(user_id, at_ms);
CREATE INDEX IF NOT EXISTS attendance_time ON attendance(at_ms);
`;

export const SETTING_DEFAULTS = {
  office_name: 'Our Office',
  timezone: 'Asia/Manila',
  geo_lat: '',
  geo_lng: '',
  geo_radius_m: '150',
  geo_max_accuracy_m: '100',
  parking_note: '',
};

const DEFAULT_CATALOG = [
  ['Drinks', 'Bottled water', 'bottles'], ['Drinks', 'Water refill jugs', 'jugs'], ['Drinks', 'Soft drinks', 'cans'],
  ['Drinks', 'Juice', 'packs'], ['Drinks', 'Tea bags', 'boxes'], ['Drinks', 'Creamer', 'packs'], ['Drinks', 'Sugar', 'packs'],
  ['Coffee', 'Coffee beans', 'kg'], ['Coffee', 'Instant coffee', 'packs'],
  ['Restroom', 'Toilet paper', 'packs'], ['Restroom', 'Hand soap', 'bottles'], ['Restroom', 'Paper towels', 'rolls'], ['Restroom', 'Facial tissue', 'boxes'],
  ['Paper and stationery', 'Bond paper, A4', 'reams'], ['Paper and stationery', 'Bond paper, Letter (short)', 'reams'],
  ['Paper and stationery', 'Bond paper, Legal (long)', 'reams'], ['Paper and stationery', 'Staples', 'boxes'],
  ['Paper and stationery', 'Pens', 'pcs'], ['Paper and stationery', 'Sticky notes', 'pads'],
  ['Paper and stationery', 'Folders and envelopes', 'pcs'], ['Paper and stationery', 'Printer ink or toner', 'pcs'],
  ['Pantry', 'Disposable cups', 'packs'], ['Pantry', 'Stirrers', 'packs'], ['Pantry', 'Dish soap', 'bottles'],
];

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'office.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  const setDefault = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(SETTING_DEFAULTS)) setDefault.run(k, v);
  const addCat = db.prepare('INSERT OR IGNORE INTO supply_catalog (category, name, unit) VALUES (?, ?, ?)');
  if (db.prepare('SELECT COUNT(*) AS n FROM supply_catalog').get().n === 0) {
    for (const [c, n, u] of DEFAULT_CATALOG) addCat.run(c, n, u);
  }
  return db;
}

export function getSettings(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}
