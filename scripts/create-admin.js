// Usage: npm run create-admin -- you@company.com "Your Name" [password]
// Creates (or promotes) an office admin. If no password is given, a temporary one is printed and must be changed at first sign-in.
import path from 'node:path';
import { openDb } from '../server/db.js';
import { hashPassword } from '../server/auth.js';
import { tempPassword } from '../server/util.js';

const [email, name, given] = process.argv.slice(2);
if (!email || !name) {
  console.error('Usage: npm run create-admin -- you@company.com "Your Name" [password]');
  process.exit(1);
}
const db = openDb(path.resolve(process.env.DATA_DIR || './data'));
const pw = given || tempPassword();
if (pw.length < 8) { console.error('Password must be at least 8 characters.'); process.exit(1); }
const hash = await hashPassword(pw);
const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
if (existing) {
  db.prepare("UPDATE users SET role='admin', can_post=1, active=1, password_hash=?, must_change_pw=? WHERE id=?").run(hash, given ? 0 : 1, existing.id);
  console.log(`Updated ${email} to admin.`);
} else {
  db.prepare("INSERT INTO users (email, name, password_hash, role, can_post, must_change_pw, created_at) VALUES (?, ?, ?, 'admin', 1, ?, ?)")
    .run(email.toLowerCase(), name, hash, given ? 0 : 1, Date.now());
  console.log(`Created admin ${email}.`);
}
if (!given) console.log(`Temporary password: ${pw}   (you will be asked to change it when you sign in)`);
