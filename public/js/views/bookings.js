// Shared by Rooms and Parking: a day timeline per room or slot, click to book, and a "my bookings" list.
import { h, clear, fmt, pill, empty, armButton, formModal, openDialog, dlgHead, toast, ymd, atLocal, pad } from '../ui.js';
import { get, post, del } from '../api.js';

const FIRST_HOUR = 7, LAST_HOUR = 21; // visible window of the day
const HOURS = LAST_HOUR - FIRST_HOUR;

export default async function bookingsView(root, app, kind) {
  const isRoom = kind === 'room';
  const noun = isRoom ? 'room' : 'parking slot';
  let day = new Date(); day.setHours(0, 0, 0, 0);
  const { resources } = await get('/api/resources?kind=' + kind);

  const dateInput = h('input', { type: 'date', 'aria-label': 'Day', value: ymd(day), onchange: () => { if (dateInput.value) { day = new Date(dateInput.value + 'T00:00:00'); draw(); } } });
  const step = (n) => () => { day = new Date(day.getTime() + n * 86400000); day.setHours(0, 0, 0, 0); dateInput.value = ymd(day); draw(); };
  const board = h('div', {});
  const mineBox = h('div', {});
  const dayTitle = h('h2', {});

  root.append(
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, isRoom ? 'Rooms' : 'Parking'),
        h('p', {}, isRoom ? 'See which meeting rooms are free and book one. Two meetings can never overlap in the same room.' : 'Book a slot for yourself, a VIP or a guest. One slot, one vehicle at a time.'),
        !isRoom && app.settings.parking_note ? h('p', {}, app.settings.parking_note) : null),
      resources.length ? h('button', { class: 'btn', onclick: () => openBook() }, isRoom ? 'Book a room' : 'Book a slot') : null),
    h('div', { class: 'row', style: { marginBottom: '12px' } },
      h('button', { class: 'btn ghost sm', onclick: step(-1), 'aria-label': 'Previous day' }, '‹'),
      h('button', { class: 'btn ghost sm', onclick: () => { day = new Date(); day.setHours(0, 0, 0, 0); dateInput.value = ymd(day); draw(); } }, 'Today'),
      h('button', { class: 'btn ghost sm', onclick: step(1), 'aria-label': 'Next day' }, '›'),
      h('div', { style: { width: '170px' } }, dateInput), dayTitle),
    resources.length ? board : empty(`No ${noun}s have been set up yet. ${app.user.is_admin ? 'Add them under Admin.' : 'Ask an admin to add them.'}`),
    h('h2', { style: { margin: '26px 0 10px' } }, 'My upcoming bookings'), mineBox);

  let bookings = [];
  async function load() {
    const from = day.getTime(), to = from + 86400000;
    bookings = (await get(`/api/bookings?kind=${kind}&from=${from}&to=${to}`)).bookings;
    const mine = (await get('/api/bookings/mine')).bookings.filter((b) => b.kind === kind);
    clear(mineBox).append(mine.length ? h('ul', { class: 'list' }, mine.map((b) => h('li', {},
      h('div', { class: 'grow' }, h('div', { class: 'title-row' }, h('strong', {}, b.resource_name), h('span', { class: 'muted' }, b.title)),
        h('div', { class: 'meta' }, `${fmt.date(b.start_at)} · ${fmt.time(b.start_at)} to ${fmt.time(b.end_at)}`, b.plate ? ` · ${b.plate}` : '')),
      armButton('Cancel', () => cancel(b))))) : empty(`You have no upcoming ${noun} bookings.`));
  }

  async function cancel(b) {
    try { await del('/api/bookings/' + b.id); toast('Booking cancelled.'); await draw(); } catch (e) { toast(e.message); }
  }

  async function draw() {
    if (!resources.length) return;
    dayTitle.textContent = fmt.dateLong(day.getTime());
    try { await load(); } catch (e) { toast(e.message); return; }
    const start = day.getTime() + FIRST_HOUR * 3600000, span = HOURS * 3600000;
    const pct = (ms) => Math.max(0, Math.min(100, ((ms - start) / span) * 100));
    const rowsEl = [h('div', { class: 'tl-row tl-head' }, h('div', { class: 'tl-name' }, ''),
      h('div', { class: 'tl-track' }, Array.from({ length: HOURS + 1 }, (_, i) => h('span', { class: 'tl-hour', style: { left: (i / HOURS) * 100 + '%' } }, `${(FIRST_HOUR + i) % 12 || 12}${FIRST_HOUR + i < 12 ? 'a' : 'p'}`))))];
    const now = Date.now();
    for (const res of resources) {
      const track = h('div', { class: 'tl-track', role: 'group', 'aria-label': `${res.name} timeline` });
      track.style.setProperty('--hours', HOURS);
      track.addEventListener('click', (e) => {
        if (e.target !== track) return;
        const rect = track.getBoundingClientRect();
        const mins = Math.round(((e.clientX - rect.left) / rect.width) * HOURS * 2) * 30; // snap to 30 min
        const t = new Date(start + mins * 60000);
        openBook({ resource_id: res.id, date: ymd(day), start: `${pad(t.getHours())}:${pad(t.getMinutes())}` });
      });
      for (const b of bookings.filter((x) => x.resource_id === res.id)) {
        const left = pct(b.start_at), right = pct(b.end_at);
        if (right <= left) continue;
        track.append(h('button', { class: 'tl-bar' + (b.user_id === app.user.id ? ' mine' : ''), style: { left: left + '%', width: right - left + '%' },
          title: `${b.title} · ${b.user_name} · ${fmt.time(b.start_at)} to ${fmt.time(b.end_at)}`, onclick: (e) => { e.stopPropagation(); detail(b); } },
          isRoom ? b.title : (b.party === 'self' ? b.user_name : b.title)));
      }
      if (now >= start && now <= start + span) track.append(h('span', { class: 'tl-now', style: { left: pct(now) + '%' } }));
      rowsEl.push(h('div', { class: 'tl-row' },
        h('div', { class: 'tl-name' }, res.name, isRoom && res.capacity ? h('small', {}, `${res.capacity} seats`) : res.detail ? h('small', {}, res.detail) : null), track));
    }
    clear(board).append(h('div', { class: 'tl' }, h('div', { class: 'tl-inner' }, rowsEl)), h('p', { class: 'hint' }, `Tap an empty spot on a row to book it. Your bookings are shown in green.`));
  }

  function detail(b) {
    let ref;
    const can = b.user_id === app.user.id || app.user.is_admin;
    ref = openDialog([dlgHead(b.title, () => ref),
      h('p', {}, h('strong', {}, b.resource_name), ` · ${fmt.dateLong(b.start_at)}`),
      h('p', {}, `${fmt.time(b.start_at)} to ${fmt.time(b.end_at)}`),
      h('p', { class: 'muted' }, `Booked by ${b.user_name}`),
      b.guest_name ? h('p', {}, `${b.party === 'vip' ? 'VIP' : 'Guest'}: ${b.guest_name}`) : null,
      b.plate ? h('p', {}, `Plate: ${b.plate}`) : null,
      b.notes ? h('p', { class: 'note' }, b.notes) : null,
      can && b.end_at > Date.now() ? h('div', { class: 'dlg-actions' }, armButton('Cancel this booking', async () => { ref.close(); await cancel(b); }, 'btn danger')) : null]);
  }

  function openBook(pre = {}) {
    const nowD = new Date();
    const t0 = new Date(Math.ceil(nowD.getTime() / 1800000) * 1800000);
    const fields = [
      { name: 'resource_id', label: isRoom ? 'Room' : 'Slot', type: 'select', required: true, options: resources.map((r) => ({ value: String(r.id), label: r.name + (isRoom && r.capacity ? ` (${r.capacity} seats)` : '') })) },
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'start', label: 'From', type: 'time', required: true },
      { name: 'end', label: 'Until', type: 'time', required: true },
    ];
    if (isRoom) fields.push({ name: 'title', label: 'Meeting title', type: 'text', required: true, max: 120 });
    else fields.push(
      { name: 'party', label: 'Who is it for?', type: 'select', options: [{ value: 'self', label: 'Me' }, { value: 'vip', label: 'A VIP' }, { value: 'guest', label: 'A guest' }] },
      { name: 'guest_name', label: 'Name', type: 'text', max: 80, required: true, showIf: (v) => v.party && v.party !== 'self' },
      { name: 'plate', label: 'Plate number', type: 'text', max: 16, showIf: (v) => v.party && v.party !== 'self' });
    fields.push({ name: 'notes', label: 'Notes', type: 'textarea', max: 300 });
    const startDefault = pre.start || `${pad(t0.getHours())}:${pad(t0.getMinutes())}`;
    const [sh, sm] = startDefault.split(':').map(Number);
    const endDefault = isRoom ? `${pad(Math.min(23, sh + 1))}:${pad(sm)}` : '18:00';
    formModal({
      title: isRoom ? 'Book a room' : 'Book a parking slot', submitLabel: 'Book it',
      initial: { resource_id: String(pre.resource_id || resources[0].id), date: pre.date || ymd(day), start: pre.start || startDefault, end: pre.start ? endDefault : endDefault, party: 'self' },
      fields,
      onSubmit: async (v) => {
        const start_at = atLocal(v.date, v.start), end_at = atLocal(v.date, v.end);
        if (!(end_at > start_at)) throw new Error('The end time must be after the start time.');
        await post('/api/bookings', { resource_id: Number(v.resource_id), start_at, end_at, title: v.title, party: v.party, guest_name: v.guest_name, plate: v.plate, notes: v.notes });
        toast('Booked.');
        day = new Date(v.date + 'T00:00:00'); dateInput.value = v.date;
        await draw();
      },
    });
  }

  await draw();
}
