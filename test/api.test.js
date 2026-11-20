import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { hashPassword } from '../server/auth.js';
import { todayIn } from '../server/util.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
const HOUR = 3600 * 1000;

// Pretend internet: Open Library search + a cover that redirects to archive.org, plus a Wikipedia lookup.
const fetchedUrls = [];
async function fakeFetch(url) {
  fetchedUrls.push(String(url));
  const u = new URL(url);
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.hostname === 'openlibrary.org') return json({ docs: [{ title: 'Dune', author_name: ['Frank Herbert'], cover_i: 42, first_publish_year: 1965 }, { title: 'No cover' }] });
  if (u.hostname === 'covers.openlibrary.org') return new Response(null, { status: 302, headers: { location: 'https://ia800.us.archive.org/cover.jpg' } });
  if (u.hostname === 'ia800.us.archive.org' || u.hostname === 'upload.wikimedia.org') return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
  if (u.hostname === 'en.wikipedia.org') return json({ query: { pages: { 1: { index: 1, title: 'Catan', description: 'Board game', thumbnail: { source: 'https://upload.wikimedia.org/catan.png' } }, 2: { index: 2, title: 'No image' } } } });
  throw new Error('unexpected host ' + u.hostname);
}

let server, base, db, dataDir, ctx;

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, { json, form } = {}) {
    const headers = {};
    if (this.cookie) headers.cookie = this.cookie;
    let body;
    if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) body = form;
    const res = await fetch(base + url, { method, headers, body });
    const sc = res.headers.getSetCookie?.() || [];
    if (sc.length) { const c = sc[0].split(';')[0]; this.cookie = c.endsWith('=') ? '' : c; }
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
    return { status: res.status, data, res };
  }
  get(u) { return this.req('GET', u); }
  post(u, json) { return this.req('POST', u, { json }); }
  patch(u, json) { return this.req('PATCH', u, { json }); }
  del(u) { return this.req('DELETE', u); }
}

async function addUser(email, { name = email.split('@')[0], role = 'member', can_post = 0, must_change_pw = 0, birthday = null, hired_on = null } = {}) {
  const info = db.prepare('INSERT INTO users (email, name, password_hash, role, can_post, must_change_pw, birthday, hired_on, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(email, name, await hashPassword('password123'), role, can_post, must_change_pw, birthday, hired_on, Date.now());
  return Number(info.lastInsertRowid);
}
async function login(email, password = 'password123') {
  const c = new Client();
  const r = await c.post('/api/login', { email, password });
  assert.equal(r.status, 200, `login failed for ${email}: ${JSON.stringify(r.data)}`);
  return c;
}

let admin, ann, ben, room, slot;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-test-'));
  const made = createApp({ dataDir, fetchImpl: fakeFetch });
  db = made.db; ctx = made.ctx;
  await new Promise((r) => { server = made.app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  await addUser('admin@x.com', { name: 'Admin', role: 'admin' });
  await addUser('ann@x.com', { name: 'Ann' });
  await addUser('ben@x.com', { name: 'Ben' });
  admin = await login('admin@x.com');
  ann = await login('ann@x.com');
  ben = await login('ben@x.com');
  room = (await admin.req('POST', '/api/admin/resources', { json: { kind: 'room', name: 'Room A', capacity: 8 } })).data.id;
  slot = (await admin.req('POST', '/api/admin/resources', { json: { kind: 'parking', name: 'P1' } })).data.id;
});
after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

// ---------------------------------------------------------------- auth
test('login rejects a wrong password and unauthenticated calls', async () => {
  const c = new Client();
  assert.equal((await c.post('/api/login', { email: 'ann@x.com', password: 'nope' })).status, 401);
  assert.equal((await c.get('/api/supply/requests')).status, 401);
  assert.equal((await c.get('/media/' + 'a'.repeat(32) + '.png')).status, 401);
});

test('a person with a temporary password must change it before using anything', async () => {
  await addUser('temp@x.com', { must_change_pw: 1 });
  const c = await login('temp@x.com');
  const blocked = await c.get('/api/supply/requests');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, 'password_change_required');
  assert.equal((await c.post('/api/me/password', { current: 'wrong-one', next: 'a-new-password' })).status, 400);
  assert.equal((await c.post('/api/me/password', { current: 'password123', next: 'short' })).status, 400);
  assert.equal((await c.post('/api/me/password', { current: 'password123', next: 'a-new-password' })).status, 200);
  assert.equal((await c.get('/api/supply/requests')).status, 200);
});

test('members cannot use admin or posting endpoints', async () => {
  assert.equal((await ann.post('/api/admin/users', { name: 'X', email: 'x@y.com' })).status, 403);
  assert.equal((await ann.req('PUT', '/api/admin/settings', { json: { office_name: 'Hacked' } })).status, 403);
  const f = new FormData(); f.set('title', 'Party'); f.set('starts_at', String(Date.now() + HOUR));
  assert.equal((await ann.req('POST', '/api/events', { form: f })).status, 403);
});

test('cross-site writes are refused', async () => {
  const res = await fetch(base + '/api/supply/requests', {
    method: 'POST', headers: { cookie: ann.cookie, 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ item: 'Pens', qty: 1 }),
  });
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------- rooms & parking
test('Rooms: overlapping bookings are refused, back-to-back bookings are fine', async () => {
  const t = Date.now() + 24 * HOUR;
  const a = await ann.post('/api/bookings', { resource_id: room, start_at: t, end_at: t + HOUR, title: 'Standup' });
  assert.equal(a.status, 201);
  const clash = await ben.post('/api/bookings', { resource_id: room, start_at: t + HOUR / 2, end_at: t + 1.5 * HOUR, title: 'Clash' });
  assert.equal(clash.status, 409);
  assert.match(clash.data.error, /already booked by Ann/);
  const inside = await ben.post('/api/bookings', { resource_id: room, start_at: t + 10 * 60000, end_at: t + 20 * 60000, title: 'Inside' });
  assert.equal(inside.status, 409);
  const enclosing = await ben.post('/api/bookings', { resource_id: room, start_at: t - HOUR, end_at: t + 3 * HOUR, title: 'Encloses' });
  assert.equal(enclosing.status, 409);
  const after = await ben.post('/api/bookings', { resource_id: room, start_at: t + HOUR, end_at: t + 2 * HOUR, title: 'Next' });
  assert.equal(after.status, 201);
  const before_ = await ben.post('/api/bookings', { resource_id: room, start_at: t - HOUR, end_at: t, title: 'Before' });
  assert.equal(before_.status, 201);
});

test('Rooms: ten simultaneous requests for the same slot produce exactly one booking', async () => {
  const t = Date.now() + 48 * HOUR;
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    (i % 2 ? ann : ben).post('/api/bookings', { resource_id: room, start_at: t, end_at: t + HOUR, title: 'Race ' + i })));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 9);
});

test('Rooms: validation and cancelling', async () => {
  const t = Date.now() + 72 * HOUR;
  assert.equal((await ann.post('/api/bookings', { resource_id: room, start_at: t, end_at: t - 1, title: 'Backwards' })).status, 400);
  assert.equal((await ann.post('/api/bookings', { resource_id: room, start_at: Date.now() - 3 * HOUR, end_at: Date.now() - 2 * HOUR, title: 'Past' })).status, 400);
  assert.equal((await ann.post('/api/bookings', { resource_id: room, start_at: t, end_at: t + 13 * HOUR, title: 'Too long' })).status, 400);
  assert.equal((await ann.post('/api/bookings', { resource_id: room, start_at: t, end_at: t + HOUR })).status, 400, 'title required');
  const ok = await ann.post('/api/bookings', { resource_id: room, start_at: t, end_at: t + HOUR, title: 'Mine' });
  assert.equal((await ben.del('/api/bookings/' + ok.data.id)).status, 403);
  assert.equal((await ann.del('/api/bookings/' + ok.data.id)).status, 200);
  assert.equal((await ben.post('/api/bookings', { resource_id: room, start_at: t, end_at: t + HOUR, title: 'Freed up' })).status, 201);
});

test('Parking: VIP and guest bookings need a name, and a slot cannot be double booked', async () => {
  const t = Date.now() + 24 * HOUR;
  assert.equal((await ann.post('/api/bookings', { resource_id: slot, start_at: t, end_at: t + 8 * HOUR, party: 'vip' })).status, 400);
  const vip = await ann.post('/api/bookings', { resource_id: slot, start_at: t, end_at: t + 8 * HOUR, party: 'vip', guest_name: 'Mr. Reyes', plate: 'abc 123' });
  assert.equal(vip.status, 201);
  const clash = await ben.post('/api/bookings', { resource_id: slot, start_at: t + 2 * HOUR, end_at: t + 4 * HOUR, party: 'self' });
  assert.equal(clash.status, 409);
  const list = await ben.get(`/api/bookings?kind=parking&from=${t - HOUR}&to=${t + 9 * HOUR}`);
  const b = list.data.bookings.find((x) => x.id === vip.data.id);
  assert.equal(b.plate, 'ABC 123');
  assert.equal(b.title, 'VIP: Mr. Reyes');
});

// ---------------------------------------------------------------- attendance
function selfieForm(lat, lng, accuracy, { withPhoto = true, photo = PNG } = {}) {
  const f = new FormData();
  f.set('lat', String(lat)); f.set('lng', String(lng)); f.set('accuracy', String(accuracy));
  if (withPhoto) f.set('selfie', new Blob([photo], { type: 'image/png' }), 'selfie.png');
  return f;
}
const OFFICE = { lat: 14.6507, lng: 121.0509 };

test('Attendance: blocked until the office location is set', async () => {
  const r = await ann.req('POST', '/api/attendance', { form: selfieForm(OFFICE.lat, OFFICE.lng, 10) });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'geofence_not_configured');
});

test('Attendance: geofence, accuracy and selfie rules are enforced by the server', async () => {
  const set = await admin.req('PUT', '/api/admin/settings', { json: { geo_lat: OFFICE.lat, geo_lng: OFFICE.lng, geo_radius_m: 150, geo_max_accuracy_m: 100 } });
  assert.equal(set.status, 200);

  const far = await ann.req('POST', '/api/attendance', { form: selfieForm(OFFICE.lat + 0.01, OFFICE.lng, 10) }); // about 1.1 km north
  assert.equal(far.status, 403);
  assert.equal(far.data.code, 'outside_geofence');
  assert.ok(far.data.distance_m > 1000);

  const fuzzy = await ann.req('POST', '/api/attendance', { form: selfieForm(OFFICE.lat, OFFICE.lng, 400) });
  assert.equal(fuzzy.status, 422);
  assert.equal(fuzzy.data.code, 'low_accuracy');

  assert.equal((await ann.req('POST', '/api/attendance', { form: selfieForm(OFFICE.lat, OFFICE.lng, 10, { withPhoto: false }) })).status, 400);
  assert.equal((await ann.req('POST', '/api/attendance', { form: selfieForm(OFFICE.lat, OFFICE.lng, 10, { photo: Buffer.from('<?php echo 1; ?> not an image at all') }) })).status, 400);
  assert.equal((await ann.req('POST', '/api/attendance', { form: selfieForm('abc', OFFICE.lng, 10) })).status, 400);

  const before_ = Date.now();
  const inside = await ann.req('POST', '/api/attendance', { form: selfieForm(OFFICE.lat + 0.0005, OFFICE.lng, 12) }); // about 55 m
  assert.equal(inside.status, 201);
  assert.equal(inside.data.kind, 'in');
  assert.ok(inside.data.at_ms >= before_, 'timestamp comes from the server clock');
  assert.ok(inside.data.distance_m < 100);

  const out = await ann.req('POST', '/api/attendance', { form: selfieForm(OFFICE.lat, OFFICE.lng, 12) });
  assert.equal(out.data.kind, 'out');
  const status = await ann.get('/api/attendance/status');
  assert.equal(status.data.next, 'in');

  // A client-supplied timestamp is ignored.
  const f = selfieForm(OFFICE.lat, OFFICE.lng, 12); f.set('at_ms', '1000');
  const spoof = await ann.req('POST', '/api/attendance', { form: f });
  assert.ok(spoof.data.at_ms > before_);
});

test('Attendance: selfies are private to the person and admins; reports are admin-only', async () => {
  const mine = await ann.get('/api/attendance/mine');
  const id = mine.data.records[0].id;
  assert.equal((await ann.get(`/api/attendance/${id}/photo`)).status, 200);
  assert.equal((await admin.get(`/api/attendance/${id}/photo`)).status, 200);
  assert.equal((await ben.get(`/api/attendance/${id}/photo`)).status, 403);
  assert.equal((await ben.get('/api/attendance/today')).status, 403);
  const today = await admin.get('/api/attendance/today');
  assert.equal(today.status, 200);
  assert.ok(today.data.people.find((p) => p.name === 'Ann'));
  const csv = await fetch(base + '/api/attendance/export.csv', { headers: { cookie: admin.cookie } });
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /Ann.*Clock in/);
});

// ---------------------------------------------------------------- Replenish
test('Replenish: requests, me-too and admin-only status changes', async () => {
  const q = await ann.post('/api/supply/requests', { item: 'Coffee beans', unit: 'kg', qty: 3, urgency: 'out' });
  assert.equal(q.status, 201);
  assert.equal((await ann.post(`/api/supply/requests/${q.data.id}/metoo`)).status, 400, 'cannot me-too your own');
  assert.equal((await ben.post(`/api/supply/requests/${q.data.id}/metoo`)).data.i_metoo, true);
  let list = (await ben.get('/api/supply/requests')).data.requests.find((x) => x.id === q.data.id);
  assert.equal(list.metoo_count, 1);
  assert.equal(list.i_metoo, true);
  assert.equal((await ben.patch(`/api/supply/requests/${q.data.id}`, { status: 'ordered' })).status, 403);
  assert.equal((await admin.patch(`/api/supply/requests/${q.data.id}`, { status: 'ordered' })).status, 200);
  assert.equal((await ann.del(`/api/supply/requests/${q.data.id}`)).status, 403, 'cannot cancel once ordered');
  assert.equal((await ann.post('/api/supply/requests', { item: 'Pens', qty: 0 })).status, 400);
  assert.equal((await ann.post('/api/supply/requests', { item: 'Pens', qty: 2, urgency: 'whenever' })).status, 400);
  const mine = await ann.post('/api/supply/requests', { item: 'Staples', unit: 'boxes', qty: 1 });
  assert.equal((await ann.del(`/api/supply/requests/${mine.data.id}`)).status, 200);
});

// ---------------------------------------------------------------- Library
test('Library: cover search, cover download with redirects, borrowing rules', async () => {
  const found = await admin.get('/api/library/cover-search?kind=book&q=dune');
  assert.equal(found.status, 200);
  assert.equal(found.data.results.length, 1, 'results without a cover are dropped');
  assert.match(found.data.results[0].image, /covers\.openlibrary\.org/);
  assert.equal((await ann.get('/api/library/cover-search?kind=book&q=dune')).status, 403);

  const pv = await admin.req('GET', '/api/library/cover-preview?url=' + encodeURIComponent(found.data.results[0].image));
  assert.equal(pv.status, 200, 'admin can preview a cover through the server');
  assert.equal((await ann.get('/api/library/cover-preview?url=' + encodeURIComponent(found.data.results[0].image))).status, 403);
  assert.equal((await admin.get('/api/library/cover-preview?url=' + encodeURIComponent('https://evil.example/x.png'))).status, 404, 'non-allowlisted hosts are refused');

  const wiki = await admin.get('/api/library/cover-search?kind=boardgame&q=catan');
  assert.equal(wiki.data.results[0].title, 'Catan');

  const f = new FormData();
  f.set('kind', 'book'); f.set('title', 'Dune'); f.set('creator', 'Frank Herbert'); f.set('cover_url', found.data.results[0].image);
  const made = await admin.req('POST', '/api/library', { form: f });
  assert.equal(made.status, 201);
  assert.equal(made.data.cover_error, null);

  fetchedUrls.length = 0;
  const evil = new FormData();
  evil.set('kind', 'other'); evil.set('title', 'Evil cover'); evil.set('cover_url', 'https://evil.example/x.png');
  const e = await admin.req('POST', '/api/library', { form: evil });
  assert.equal(e.status, 201);
  assert.match(e.data.cover_error, /Open Library or Wikipedia/);
  assert.equal(fetchedUrls.length, 0, 'never contacts a host outside the allowlist');

  const items = (await ann.get('/api/library')).data.items;
  const dune = items.find((i) => i.title === 'Dune');
  assert.match(dune.cover, /^[a-f0-9]{32}\.png$/);
  assert.equal((await ann.get('/media/' + dune.cover)).status, 200);

  assert.equal((await ann.post(`/api/library/${dune.id}/borrow`, {})).status, 201);
  const second = await ben.post(`/api/library/${dune.id}/borrow`, {});
  assert.equal(second.status, 409);
  assert.match(second.data.error, /Ann has this one/);
  assert.equal((await ben.post(`/api/library/${dune.id}/return`, {})).status, 400);
  assert.equal((await ann.post(`/api/library/${dune.id}/return`, {})).status, 200);
  assert.equal((await ben.post(`/api/library/${dune.id}/borrow`, {})).status, 201);
  assert.equal((await ann.req('POST', '/api/library', { form: f })).status, 403);
});

// ---------------------------------------------------------------- Events / Promos / Board
test('Events: posters can upload artwork; everyone can RSVP', async () => {
  await addUser('poster@x.com', { name: 'Pat', can_post: 1 });
  const pat = await login('poster@x.com');
  const f = new FormData();
  f.set('title', 'Christmas party'); f.set('location', 'Pantry'); f.set('starts_at', String(Date.now() + 5 * 24 * HOUR));
  f.set('image', new Blob([PNG], { type: 'image/png' }), 'poster.png');
  const made = await pat.req('POST', '/api/events', { form: f });
  assert.equal(made.status, 201);
  const ev = (await ann.get('/api/events')).data.events.find((x) => x.title === 'Christmas party');
  assert.match(ev.image, /^[a-f0-9]{32}\.png$/);
  assert.equal((await ann.get('/media/' + ev.image)).status, 200);
  assert.equal((await ann.post(`/api/events/${ev.id}/rsvp`)).data.i_going, true);
  assert.equal((await ben.del(`/api/events/${ev.id}`)).status, 403);
  const bad = new FormData();
  bad.set('title', 'Bad art'); bad.set('starts_at', String(Date.now() + HOUR)); bad.set('image', new Blob(['not an image, just words'], { type: 'image/png' }), 'x.png');
  assert.equal((await pat.req('POST', '/api/events', { form: bad })).status, 400);
  assert.equal((await pat.del(`/api/events/${ev.id}`)).status, 200);
});

test('Promos: price is posted, regular price must not be lower', async () => {
  const mk = (fields) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.set(k, String(v)); return admin.req('POST', '/api/promos', { form: f }); };
  assert.equal((await mk({ brand: 'Anta', title: 'Running shoes', price: 2999, original_price: 3999 })).status, 201);
  assert.equal((await mk({ brand: 'Wilson', title: 'Racket', price: 5000, original_price: 4000 })).status, 400);
  const list = (await ann.get('/api/promos')).data.promos;
  const p = list.find((x) => x.brand === 'Anta');
  assert.equal(p.price, 2999);
  assert.equal((await ann.post(`/api/promos/${p.id}/interest`)).data.i_interested, true);
});

test('Community Board: birthdays and anniversaries are computed from people records', async () => {
  const tz = 'Asia/Manila';
  const today = todayIn(tz);
  await addUser('bday@x.com', { name: 'Birthday Betty', birthday: today.slice(5), hired_on: `${Number(today.slice(0, 4)) - 3}-${today.slice(5)}` });
  const board = (await ann.get('/api/board')).data;
  const b = board.birthdays.find((x) => x.name === 'Birthday Betty');
  assert.equal(b.days_away, 0);
  const a = board.anniversaries.find((x) => x.name === 'Birthday Betty');
  assert.equal(a.years, 3);

  const f = new FormData(); f.set('category', 'repair'); f.set('title', 'Pantry sink under repair'); f.set('pinned', '1');
  assert.equal((await admin.req('POST', '/api/board', { form: f })).status, 201);
  const posts = (await ann.get('/api/board')).data.posts;
  assert.equal(posts[0].title, 'Pantry sink under repair');
  const badCat = new FormData(); badCat.set('category', 'nonsense'); badCat.set('title', 'x');
  assert.equal((await admin.req('POST', '/api/board', { form: badCat })).status, 400);
});

// ---------------------------------------------------------------- Admin
test('Admin: CSV import creates people with temporary passwords and reports bad rows', async () => {
  const csv = 'name,email,title,birthday,hired_on\nCarla Cruz,carla@x.com,Designer,03-14,2022-06-01\nBad Row,not-an-email,,,\nAnn Again,ann@x.com,,,\n';
  const r = await admin.post('/api/admin/users/import', { csv });
  assert.equal(r.status, 200);
  assert.equal(r.data.created.length, 1);
  assert.equal(r.data.errors.length, 2);
  const c = new Client();
  assert.equal((await c.post('/api/login', { email: 'carla@x.com', password: r.data.created[0].temp_password })).status, 200);
  assert.equal((await c.get('/api/supply/catalog')).status, 403, 'must change password first');
});

test('Admin: deactivating someone ends their session, and admins cannot lock themselves out', async () => {
  const id = await addUser('gone@x.com');
  const gone = await login('gone@x.com');
  assert.equal((await gone.get('/api/supply/catalog')).status, 200);
  assert.equal((await admin.patch(`/api/admin/users/${id}`, { active: false })).status, 200);
  assert.equal((await gone.get('/api/supply/catalog')).status, 401);
  const me = (await admin.get('/api/me')).data.user;
  assert.equal((await admin.patch(`/api/admin/users/${me.id}`, { role: 'member' })).status, 400);
});
