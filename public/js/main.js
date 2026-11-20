import { h, clear, formModal, toast, openDialog, dlgHead } from './ui.js';
import { get, post } from './api.js';

const SECTIONS = [
  { id: 'board', label: 'Board', mod: './views/board.js' },
  { id: 'replenish', label: 'Replenish', mod: './views/replenish.js' },
  { id: 'rooms', label: 'Rooms', mod: './views/rooms.js' },
  { id: 'parking', label: 'Parking', mod: './views/parking.js' },
  { id: 'library', label: 'Library', mod: './views/library.js' },
  { id: 'events', label: 'Events', mod: './views/events.js' },
  { id: 'promos', label: 'Promos', mod: './views/promos.js' },
  { id: 'attendance', label: 'Attendance', mod: './views/attendance.js' },
  { id: 'admin', label: 'Admin', mod: './views/admin.js', adminOnly: true },
];

const root = document.getElementById('app');
const app = { user: null, settings: null, section: null };
let renderToken = 0;

const logoSvg = () => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 32 32'); s.setAttribute('width', '28'); s.setAttribute('height', '28'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = '<rect width="32" height="32" rx="7" fill="#0e6b5c"/><path d="M9 22V10h5.2c3.3 0 5 1.8 5 4.1 0 2.4-1.7 4.1-5 4.1H12V22H9Zm3-6.3h2c1.4 0 2.2-.6 2.2-1.6s-.8-1.6-2.2-1.6h-2v3.2Z" fill="#fff"/><circle cx="22.5" cy="21.5" r="2.5" fill="#9fe0cf"/>';
  return s;
};

function showLogin(message) {
  clear(root);
  const err = h('div', { class: 'form-error', role: 'alert', hidden: !message }, message || '');
  const email = h('input', { id: 'email', type: 'email', autocomplete: 'username', required: true });
  const pw = h('input', { id: 'pw', type: 'password', autocomplete: 'current-password', required: true });
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Sign in');
  const form = h('form', { class: 'login-card', novalidate: true },
    h('div', { class: 'brand' }, logoSvg(), h('span', {}, 'Office Manager')),
    h('p', { class: 'muted' }, 'Sign in with your work email. Ask your office admin if you do not have a password yet.'),
    err,
    h('div', {}, h('label', { for: 'email' }, 'Email'), email),
    h('div', {}, h('label', { for: 'pw' }, 'Password'), pw),
    btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.hidden = true; btn.disabled = true;
    try { const r = await post('/api/login', { email: email.value, password: pw.value }); app.user = r.user; await boot(); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; pw.value = ''; pw.focus(); }
  });
  root.append(h('div', { class: 'login-wrap' }, form));
  email.focus();
}

function showPasswordChange() {
  clear(root);
  const err = h('div', { class: 'form-error', role: 'alert', hidden: true });
  const cur = h('input', { id: 'cur', type: 'password', autocomplete: 'current-password' });
  const n1 = h('input', { id: 'n1', type: 'password', autocomplete: 'new-password' });
  const n2 = h('input', { id: 'n2', type: 'password', autocomplete: 'new-password' });
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Save new password');
  const form = h('form', { class: 'login-card', novalidate: true },
    h('h1', {}, 'Choose your own password'),
    h('p', { class: 'muted' }, `Hi ${app.user.name}. The password you were given is temporary. Pick a new one with at least 8 characters.`),
    err,
    h('div', {}, h('label', { for: 'cur' }, 'Temporary password'), cur),
    h('div', {}, h('label', { for: 'n1' }, 'New password'), n1),
    h('div', {}, h('label', { for: 'n2' }, 'New password again'), n2),
    btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.hidden = true;
    if (n1.value !== n2.value) { err.textContent = 'The two new passwords do not match.'; err.hidden = false; return; }
    btn.disabled = true;
    try { await post('/api/me/password', { current: cur.value, next: n1.value }); app.user.must_change_pw = false; await boot(); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
  });
  root.append(h('div', { class: 'login-wrap' }, form));
  cur.focus();
}

function changePasswordDialog() {
  formModal({
    title: 'Change password',
    fields: [
      { name: 'current', label: 'Current password', type: 'password', required: true },
      { name: 'next', label: 'New password', type: 'password', required: true, hint: 'At least 8 characters.' },
    ],
    submitLabel: 'Change password',
    onSubmit: async (v) => { await post('/api/me/password', v); toast('Password changed.'); },
  });
}

function currentSection() {
  const id = location.hash.replace(/^#\/?/, '').split('/')[0] || 'board';
  return SECTIONS.find((s) => s.id === id && (!s.adminOnly || app.user.is_admin)) || SECTIONS[0];
}

async function renderSection() {
  const sec = currentSection();
  app.section = sec.id;
  document.querySelectorAll('.nav a').forEach((a) => a.setAttribute('aria-current', String(a.dataset.id === sec.id) === 'true' ? 'page' : 'false'));
  const page = document.getElementById('page');
  const token = ++renderToken;
  clear(page).append(h('p', { class: 'muted' }, 'Loading…'));
  try {
    const mod = await import(sec.mod);
    const holder = h('div', {});
    await mod.default(holder, app);
    if (token !== renderToken) return;
    clear(page).append(holder);
    window.scrollTo(0, 0);
  } catch (e) {
    if (token !== renderToken) return;
    clear(page).append(h('div', { class: 'banner bad' }, e.message || 'This page could not load.'), h('button', { class: 'btn ghost', onclick: renderSection }, 'Try again'));
  }
}

function showShell() {
  clear(root);
  const nav = h('nav', { class: 'nav', 'aria-label': 'Sections' },
    SECTIONS.filter((s) => !s.adminOnly || app.user.is_admin).map((s) => h('a', { href: '#/' + s.id, 'data-id': s.id }, s.label)));
  const menu = h('div', { class: 'who' },
    h('span', { class: 'small muted' }, app.user.name),
    h('button', { class: 'btn ghost sm', type: 'button', onclick: changePasswordDialog }, 'Password'),
    h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => { await post('/api/logout').catch(() => {}); app.user = null; showLogin(); } }, 'Sign out'));
  root.append(h('div', { class: 'shell' },
    h('header', { class: 'topbar' },
      h('div', { class: 'topbar-in' }, h('a', { class: 'brand', href: '#/board' }, logoSvg(), h('span', {}, app.settings.office_name)), menu),
      nav),
    h('main', { class: 'page', id: 'page' })));
  renderSection();
}

async function boot() {
  try {
    if (!app.user) {
      const me = await get('/api/me');
      app.user = me.user;
    }
    if (!app.user) return showLogin();
    if (app.user.must_change_pw) return showPasswordChange();
    app.settings = await get('/api/settings');
    document.title = app.settings.office_name;
    showShell();
  } catch (e) {
    clear(root).append(h('div', { class: 'login-wrap' }, h('div', { class: 'login-card' }, h('div', { class: 'banner bad' }, e.message),
      h('button', { class: 'btn', onclick: () => location.reload() }, 'Reload'))));
  }
}

window.addEventListener('hashchange', () => { if (app.user && document.getElementById('page')) renderSection(); });
window.addEventListener('om:unauth', () => { app.user = null; showLogin('Your session ended. Please sign in again.'); });
boot();
