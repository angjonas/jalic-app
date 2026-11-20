import { h, clear, mount, pill, empty, armButton, formModal, openDialog, dlgHead, toast } from '../ui.js';
import { get, post, patch, put, del } from '../api.js';

export default async function admin(root, app) {
  const body = h('div', {});
  let tab = 'people';
  const TABS = [['people', 'People'], ['places', 'Rooms and parking'], ['supplies', 'Supplies'], ['office', 'Office and location']];
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Admin sections' }, TABS.map(([k, l]) =>
    h('button', { role: 'tab', 'data-k': k, 'aria-selected': String(k === tab), onclick: () => { tab = k; tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.k === k))); show(); } }, l)));
  root.append(h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Admin'), h('p', {}, 'Manage people, rooms, parking, supplies and the office location used for attendance.'))),
    h('div', { style: { marginBottom: '16px' } }, tabs), body);

  async function show() {
    clear(body).append(h('p', { class: 'muted' }, 'Loading…'));
    try { const holder = h('div', {}); await ({ people, places, supplies, office }[tab])(holder); clear(body).append(holder); }
    catch (e) { clear(body).append(h('div', { class: 'banner bad' }, e.message)); }
  }

  function credentials(title, rows) {
    let ref;
    const text = rows.map((r) => `${r.name},${r.email},${r.temp_password}`).join('\n');
    const url = URL.createObjectURL(new Blob([`name,email,temporary_password\n${text}\n`], { type: 'text/csv' }));
    ref = openDialog([dlgHead(title, () => ref),
      h('p', { class: 'muted' }, 'Share each temporary password privately. It is only shown now, and each person must replace it at first sign-in.'),
      h('div', { class: 'tbl-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Email', 'Temporary password'].map((x) => h('th', {}, x)))),
        h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, r.name), h('td', {}, r.email), h('td', {}, h('code', {}, r.temp_password))))))),
      h('div', { class: 'dlg-actions' }, h('a', { class: 'btn ghost', href: url, download: 'temporary-passwords.csv' }, 'Download CSV'), h('button', { class: 'btn', onclick: () => ref.close() }, 'Done'))], { wide: true });
  }

  const personFields = (editing) => [
    { name: 'name', label: 'Full name', type: 'text', required: true, max: 80 },
    { name: 'email', label: 'Work email', type: 'email', required: true },
    { name: 'title', label: 'Job title', type: 'text', max: 80 },
    { name: 'role', label: 'Access', type: 'select', options: [{ value: 'member', label: 'Member' }, { value: 'admin', label: 'Admin (manages everything)' }] },
    { name: 'can_post', label: 'Can post to the Board, Events and Promos', type: 'checkbox' },
    { name: 'birthday', label: 'Birthday', type: 'text', placeholder: 'MM-DD, e.g. 03-14', hint: 'Used for the birthday list on the Board. The year is not needed.' },
    { name: 'hired_on', label: 'Start date', type: 'date', hint: 'Used for work anniversaries.' },
    ...(editing ? [{ name: 'active', label: 'Active (untick when someone leaves)', type: 'checkbox' }] : []),
  ];

  async function people(box) {
    const { users } = await get('/api/admin/users');
    box.append(
      h('div', { class: 'row', style: { marginBottom: '12px' } },
        h('button', { class: 'btn', onclick: () => formModal({ title: 'Add a person', submitLabel: 'Create account', initial: { role: 'member' }, fields: personFields(false),
          onSubmit: async (v) => { const r = await post('/api/admin/users', v); credentials('Account created', [{ name: v.name, email: v.email, temp_password: r.temp_password }]); show(); } }) }, 'Add a person'),
        h('button', { class: 'btn ghost', onclick: () => importDialog() }, 'Import from CSV'),
        h('span', { class: 'muted small' }, `${users.filter((u) => u.active).length} active people`)),
      h('div', { class: 'tbl-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Email', 'Access', 'Birthday', 'Start', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, users.map((u) => h('tr', {},
          h('td', {}, u.name, u.title ? h('div', { class: 'small muted' }, u.title) : null),
          h('td', {}, u.email),
          h('td', {}, u.role === 'admin' ? pill('Admin', 'ok') : u.can_post ? pill('Poster', 'info') : pill('Member'), !u.active ? pill('Inactive', 'crit') : null, u.must_change_pw ? pill('Temp password', 'warn') : null),
          h('td', {}, u.birthday || '–'), h('td', {}, u.hired_on || '–'),
          h('td', {}, h('div', { class: 'row' },
            h('button', { class: 'btn ghost sm', onclick: () => formModal({ title: 'Edit person', initial: { ...u, can_post: !!u.can_post, active: !!u.active }, fields: personFields(true),
              onSubmit: async (v) => { await patch('/api/admin/users/' + u.id, v); toast('Saved.'); show(); } }) }, 'Edit'),
            armButton('Reset password', async () => { const r = await post(`/api/admin/users/${u.id}/reset-password`); credentials('New temporary password', [{ name: u.name, email: u.email, temp_password: r.temp_password }]); })))))))));
  }

  function importDialog() {
    let text = '';
    const area = h('textarea', { id: 'csv', placeholder: 'name,email,title,birthday,hired_on\nCarla Cruz,carla@company.com,Designer,03-14,2022-06-01' });
    const file = h('input', { type: 'file', accept: '.csv,text/csv', onchange: async () => { if (file.files[0]) area.value = await file.files[0].text(); } });
    const err = h('div', { class: 'form-error', hidden: true });
    let ref;
    const go = h('button', { class: 'btn', onclick: async () => {
      err.hidden = true; go.disabled = true;
      try {
        const r = await post('/api/admin/users/import', { csv: area.value });
        ref.close();
        if (r.created.length) credentials(`${r.created.length} accounts created`, r.created);
        if (r.errors.length) toast(`${r.errors.length} rows were skipped: ${r.errors.slice(0, 3).map((e) => `line ${e.line} (${e.error})`).join('; ')}`);
        show();
      } catch (e) { err.textContent = e.message; err.hidden = false; go.disabled = false; }
    } }, 'Create accounts');
    ref = openDialog([dlgHead('Import people from CSV', () => ref),
      h('p', { class: 'muted' }, 'First row must be a header with at least name and email. Optional columns: title, birthday (MM-DD), hired_on (YYYY-MM-DD), role (member or admin). Export from Excel or Google Sheets as CSV.'),
      h('div', {}, h('label', { for: 'csv' }, 'Paste CSV or choose a file'), area), file, err, h('div', { class: 'dlg-actions' }, go)], { wide: true });
  }

  async function places(box) {
    const all = {};
    for (const kind of ['room', 'parking']) all[kind] = (await get('/api/resources?kind=' + kind)).resources;
    const section = (kind, title, noun) => {
      const f = (r) => [
        { name: 'name', label: 'Name', type: 'text', required: true, max: 60, placeholder: kind === 'room' ? 'e.g. Boardroom' : 'e.g. P12' },
        { name: 'detail', label: 'Note', type: 'text', max: 200, placeholder: kind === 'room' ? 'e.g. TV, whiteboard' : 'e.g. Near the entrance' },
        ...(kind === 'room' ? [{ name: 'capacity', label: 'Seats', type: 'number', min: 1, max: 500 }] : []),
      ];
      return h('section', { class: 'stack', style: { marginBottom: '28px' } },
        h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('h2', {}, title),
          h('button', { class: 'btn', onclick: () => formModal({ title: `Add ${noun}`, fields: f(), initial: {}, onSubmit: async (v) => { await post('/api/admin/resources', { ...v, kind, capacity: v.capacity || null }); show(); } }) }, `Add ${noun}`)),
        all[kind].length ? h('ul', { class: 'list' }, all[kind].map((r) => h('li', {},
          h('div', { class: 'grow' }, h('strong', {}, r.name), h('div', { class: 'small muted' }, [r.capacity ? `${r.capacity} seats` : '', r.detail || ''].filter(Boolean).join(' · '))),
          h('div', { class: 'row' }, h('button', { class: 'btn ghost sm', onclick: () => formModal({ title: `Edit ${noun}`, fields: f(), initial: r,
            onSubmit: async (v) => { await patch('/api/admin/resources/' + r.id, { ...v, capacity: v.capacity || null }); show(); } }) }, 'Edit'),
            armButton('Remove', async () => { await del('/api/admin/resources/' + r.id); show(); }))))) : empty(`No ${noun}s yet.`));
    };
    box.append(section('room', 'Meeting rooms', 'room'), section('parking', 'Parking slots', 'slot'));
  }

  async function supplies(box) {
    const { items } = await get('/api/supply/catalog');
    const byCat = {};
    for (const i of items) (byCat[i.category] ||= []).push(i);
    mount(box,
      h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '12px' } }, h('p', { class: 'muted' }, 'These appear in the Replenish picker. People can still request anything else under "Something else".'),
        h('button', { class: 'btn', onclick: () => formModal({ title: 'Add a supply item', initial: { unit: 'pcs' }, fields: [
          { name: 'category', label: 'Category', type: 'text', required: true, max: 40, placeholder: 'e.g. Drinks' },
          { name: 'name', label: 'Item', type: 'text', required: true, max: 80 },
          { name: 'unit', label: 'Unit', type: 'text', required: true, max: 20, placeholder: 'e.g. boxes' }],
          onSubmit: async (v) => { await post('/api/supply/catalog', v); show(); } }) }, 'Add item')),
      Object.entries(byCat).map(([c, rows]) => h('section', { style: { marginBottom: '18px' } }, h('h3', { style: { marginBottom: '8px' } }, c),
        h('ul', { class: 'list' }, rows.map((i) => h('li', {}, h('span', {}, i.name, h('span', { class: 'muted' }, ` · ${i.unit}`)),
          armButton('Remove', async () => { await del('/api/supply/catalog/' + i.id); show(); })))))));
  }

  async function office(box) {
    const g = app.settings.geofence;
    const inp = (id, label, value, attrs = {}, hint) => h('div', {}, h('label', { for: id }, label), h('input', { id, value: value ?? '', ...attrs }), hint ? h('p', { class: 'hint' }, hint) : null);
    const name = inp('o_name', 'Office name', app.settings.office_name, { maxlength: 80 });
    const tz = inp('o_tz', 'Timezone', app.settings.timezone, { maxlength: 60 }, 'Used for "today" in attendance and birthdays. Example: Asia/Manila.');
    const lat = inp('o_lat', 'Office latitude', g.lat, { inputmode: 'decimal' });
    const lng = inp('o_lng', 'Office longitude', g.lng, { inputmode: 'decimal' });
    const rad = inp('o_rad', 'Allowed distance from the office (metres)', g.radius_m, { type: 'number', min: 20, max: 5000 }, 'People must be inside this circle to clock in or out. 100 to 200 m suits most offices.');
    const acc = inp('o_acc', 'Largest GPS error allowed (metres)', g.max_accuracy_m, { type: 'number', min: 10, max: 1000 }, 'Readings less precise than this are refused, so a weak signal cannot be used to fake presence.');
    const note = inp('o_pn', 'Parking note shown on the Parking page', app.settings.parking_note, { maxlength: 300 });
    const msg = h('p', { class: 'hint' }, 'Stand in the middle of the office and press the button to fill in the coordinates, or paste them from a maps app.');
    const useHere = h('button', { class: 'btn ghost', type: 'button', onclick: () => {
      if (!navigator.geolocation) { msg.textContent = 'This browser cannot share its location.'; return; }
      msg.textContent = 'Finding your location…';
      navigator.geolocation.getCurrentPosition((p) => { lat.querySelector('input').value = p.coords.latitude.toFixed(6); lng.querySelector('input').value = p.coords.longitude.toFixed(6); msg.textContent = `Filled in (accurate to about ${Math.round(p.coords.accuracy)} m). Press Save to apply it.`; },
        () => { msg.textContent = 'Could not get your location. Allow it for this site (it needs HTTPS), or paste the coordinates by hand.'; }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    } }, 'Use my current location');
    const err = h('div', { class: 'form-error', hidden: true });
    const save = h('button', { class: 'btn', type: 'submit' }, 'Save settings');
    const form = h('form', { class: 'panel form', novalidate: true },
      h('h2', {}, 'Office'), name, tz, note,
      h('h2', { style: { marginTop: '10px' } }, 'Attendance geofence'), h('div', { class: 'row2' }, lat, lng), h('div', {}, useHere, msg), h('div', { class: 'row2' }, rad, acc), err, h('div', {}, save));
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.hidden = true; save.disabled = true;
      const v = (el) => el.querySelector('input').value.trim();
      const body = { office_name: v(name), timezone: v(tz), parking_note: v(note), geo_radius_m: v(rad), geo_max_accuracy_m: v(acc) };
      if (v(lat) || v(lng)) { body.geo_lat = v(lat); body.geo_lng = v(lng); }
      try { await put('/api/admin/settings', body); Object.assign(app.settings, await get('/api/settings')); toast('Settings saved.'); document.title = app.settings.office_name; }
      catch (ex) { err.textContent = ex.message; err.hidden = false; } finally { save.disabled = false; }
    });
    box.append(h('div', { style: { maxWidth: '640px' } }, form));
  }

  show();
}
