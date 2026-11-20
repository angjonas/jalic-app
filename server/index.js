import path from 'node:path';
import { createApp } from './app.js';
import { hashPassword, checkPasswordStrength } from './auth.js';

const dataDir = path.resolve(process.env.DATA_DIR || './data');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
// Set BEHIND_HTTPS=1 when a reverse proxy terminates HTTPS in front of this app.
const behindHttps = process.env.BEHIND_HTTPS === '1';

const { app, db } = createApp({ dataDir, secureCookies: behindHttps, trustProxy: behindHttps });

// First-run admin for hosts without a shell (Render, Railway...): set ADMIN_EMAIL, ADMIN_PASSWORD and optionally ADMIN_NAME.
// It only runs while there are no users at all, so it never overwrites a password later. Remove the variables afterwards.
const { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
if (ADMIN_EMAIL && ADMIN_PASSWORD && db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
  let weak = null;
  try { checkPasswordStrength(ADMIN_PASSWORD); } catch (e) { weak = e.message; }
  if (weak) console.error('ADMIN_PASSWORD rejected: ' + weak);
  else {
    db.prepare("INSERT INTO users (email, name, password_hash, role, can_post, must_change_pw, created_at) VALUES (?, ?, ?, 'admin', 1, 1, ?)")
      .run(ADMIN_EMAIL.toLowerCase(), ADMIN_NAME || 'Office Admin', await hashPassword(ADMIN_PASSWORD), Date.now());
    console.log(`First-run admin created for ${ADMIN_EMAIL}. You will be asked to choose a new password at first sign-in.`);
  }
}
app.listen(port, host, () => {
  console.log(`Office Manager running on http://${host}:${port}  (data: ${dataDir})`);
  if (!behindHttps) console.log('Note: camera and GPS only work over HTTPS or on localhost. See README.md.');
});
