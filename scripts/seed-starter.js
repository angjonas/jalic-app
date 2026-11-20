// Optional: adds placeholder meeting rooms and parking slots so Rooms and Parking are usable on day one.
// Rename or delete them under Admin > Rooms and parking. Safe to run more than once.
import path from 'node:path';
import { openDb } from '../server/db.js';

const db = openDb(path.resolve(process.env.DATA_DIR || './data'));
const has = (kind) => db.prepare('SELECT COUNT(*) AS n FROM resources WHERE kind = ? AND active = 1').get(kind).n > 0;
const add = db.prepare('INSERT INTO resources (kind, name, detail, capacity) VALUES (?, ?, ?, ?)');

if (!has('room')) {
  add.run('room', 'Room A', 'Placeholder: rename me', 6);
  add.run('room', 'Room B', 'Placeholder: rename me', 10);
  add.run('room', 'Boardroom', 'Placeholder: rename me', 16);
  console.log('Added 3 placeholder meeting rooms.');
}
if (!has('parking')) {
  for (let i = 1; i <= 10; i++) add.run('parking', `P${i}`, null, null);
  console.log('Added 10 placeholder parking slots (P1 to P10).');
}
console.log('Done.');
