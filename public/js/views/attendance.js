import { h, clear, mount, fmt, pill, empty, openDialog, dlgHead, toast, ymd } from '../ui.js';
import { get, api } from '../api.js';

function distanceM(lat1, lon1, lat2, lon2) {
  const rad = (x) => (x * Math.PI) / 180, R = 6371008.8;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export default async function attendance(root, app) {
  let status = await get('/api/attendance/status');
  const gf = app.settings.geofence;
  const clockBox = h('div', { class: 'panel clock-card' });
  const histBox = h('div', {});
  const adminBox = h('div', {});

  mount(root,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Attendance'),
      h('p', {}, 'Clock in and out with a selfie. Your phone shares your location, and you must be at the office. The time is recorded by the server.'))),
    !gf.configured ? h('div', { class: 'banner' }, app.user.is_admin ? 'Set the office location under Admin, then Office and location, before anyone can clock in.' : 'Attendance is not set up yet. Your office admin needs to set the office location first.') : null,
    !window.isSecureContext ? h('div', { class: 'banner bad' }, 'This page is not using HTTPS, so the camera and location are blocked by your browser. Ask your admin to set up HTTPS (see the README).') : null,
    clockBox, h('h2', { style: { margin: '26px 0 10px' } }, 'My recent clock-ins'), histBox, adminBox);

  function drawClock() {
    const last = status.last;
    const inNow = status.next === 'out';
    mount(clear(clockBox),
      h('p', { class: 'clock-state' }, inNow ? h('span', {}, 'You are ', pill('Clocked in', 'ok'), last ? ` since ${fmt.time(last.at_ms)}` : '') : h('span', {}, 'You are ', pill('Clocked out'), last ? ` (last ${last.kind === 'in' ? 'in' : 'out'}: ${fmt.dateTime(last.at_ms)})` : '')),
      status.missed_out ? h('p', { class: 'small muted' }, 'Your last clock-in has no clock-out. Clocking in now starts a new day.') : null,
      h('button', { class: 'btn big', disabled: !gf.configured, onclick: () => openClock() }, inNow ? 'Clock out' : 'Clock in'),
      h('p', { class: 'small muted' }, gf.configured ? `You need to be within ${gf.radius_m} m of the office.` : ''));
  }

  async function drawHistory() {
    const { records } = await get('/api/attendance/mine');
    clear(histBox).append(records.length ? h('ul', { class: 'list' }, records.slice(0, 20).map((r) => h('li', {},
      h('div', { class: 'row' }, h('img', { class: 'thumb', src: `/api/attendance/${r.id}/photo`, alt: 'Selfie', loading: 'lazy' }),
        h('div', {}, h('strong', {}, r.kind === 'in' ? 'Clock in' : 'Clock out'), h('div', { class: 'small muted' }, fmt.dateTime(r.at_ms)))),
      h('span', { class: 'small muted' }, `${Math.round(r.distance_m)} m from office`)))) : empty('No clock-ins yet.'));
  }

  function openClock() {
    let stream = null, blob = null, pos = null, watchId = null, ref;
    const video = h('video', { class: 'mirror', autoplay: true, playsinline: true, muted: true });
    const shot = h('img', { alt: 'Your selfie', hidden: true });
    const gps = h('div', { class: 'gps', role: 'status' }, 'Finding your location…');
    const err = h('div', { class: 'form-error', role: 'alert', hidden: true });
    const fileIn = h('input', { type: 'file', accept: 'image/*', capture: 'user', hidden: true });
    const takeBtn = h('button', { class: 'btn', type: 'button' }, 'Take selfie');
    const retake = h('button', { class: 'btn ghost', type: 'button', hidden: true }, 'Retake');
    const fallback = h('button', { class: 'btn', type: 'button', hidden: true }, 'Open camera');
    const camNote = h('p', { class: 'small muted', hidden: true });
    const submit = h('button', { class: 'btn', type: 'button', disabled: true }, status.next === 'in' ? 'Clock in' : 'Clock out');
    const camBox = h('div', { class: 'cam' }, video, shot);

    const refreshSubmit = () => { submit.disabled = !(blob && pos); };
    function showShot(b) {
      blob = b; shot.src = URL.createObjectURL(b); shot.hidden = false; video.hidden = true;
      takeBtn.hidden = true; fallback.hidden = true; retake.hidden = false; refreshSubmit();
    }
    function camFail(msg) {
      camBox.hidden = true; takeBtn.hidden = true; fallback.hidden = false; camNote.textContent = msg; camNote.hidden = false;
    }
    async function startCam() {
      if (!navigator.mediaDevices?.getUserMedia) { camFail('This browser cannot open the camera here. Use the button to take a photo instead.'); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 960 } }, audio: false });
        video.srcObject = stream; await video.play().catch(() => {});
      } catch (e) {
        camFail(e.name === 'NotAllowedError' ? 'Camera permission was blocked. Allow the camera for this site, or use the button to take a photo.' : 'No camera was found. Use the button to take a photo instead.');
      }
    }
    takeBtn.addEventListener('click', () => {
      if (!video.videoWidth) return;
      const s = Math.min(video.videoWidth, video.videoHeight), out = Math.min(720, s);
      const c = document.createElement('canvas'); c.width = c.height = out;
      c.getContext('2d').drawImage(video, (video.videoWidth - s) / 2, (video.videoHeight - s) / 2, s, s, 0, 0, out, out);
      c.toBlob((b) => b && showShot(b), 'image/jpeg', 0.85);
    });
    retake.addEventListener('click', () => {
      blob = null; shot.hidden = true; video.hidden = false; retake.hidden = true;
      if (camBox.hidden) fallback.hidden = false; else takeBtn.hidden = false; refreshSubmit();
    });
    fallback.addEventListener('click', () => fileIn.click());
    fileIn.addEventListener('change', () => { if (fileIn.files[0]) { camBox.hidden = false; showShot(fileIn.files[0]); } });

    function onPos(p) {
      pos = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
      const acc = Math.round(pos.accuracy);
      let text = `Location found (accurate to about ${acc} m).`, cls = 'gps ok';
      if (gf.configured) {
        const d = Math.round(distanceM(gf.lat, gf.lng, pos.lat, pos.lng));
        if (acc > gf.max_accuracy_m) { text += ` That is not precise enough (limit ${gf.max_accuracy_m} m). Wait a few seconds or move near a window.`; cls = 'gps bad'; }
        else if (d > gf.radius_m) { text += ` You look to be about ${d} m from the office, but you must be within ${gf.radius_m} m.`; cls = 'gps bad'; }
        else text += ` About ${d} m from the office.`;
      }
      gps.className = cls; gps.textContent = text; refreshSubmit();
    }
    function onPosErr(e) {
      gps.className = 'gps bad';
      gps.textContent = e.code === 1 ? 'Location permission was blocked. Allow location for this site in your browser settings, then reopen this window.'
        : e.code === 3 ? 'Still looking for your location. Move near a window or outdoors and wait a moment.' : 'Your location is not available right now.';
    }
    if (!navigator.geolocation) onPosErr({ code: 2 });
    else watchId = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
    startCam();

    submit.addEventListener('click', async () => {
      err.hidden = true; submit.disabled = true; submit.textContent = 'Saving…';
      const fd = new FormData();
      fd.append('selfie', blob, 'selfie.jpg'); fd.append('lat', pos.lat); fd.append('lng', pos.lng); fd.append('accuracy', pos.accuracy);
      try {
        const r = await api('POST', '/api/attendance', fd);
        toast(`${r.kind === 'in' ? 'Clocked in' : 'Clocked out'} at ${fmt.time(r.at_ms)}.`);
        ref.close();
        status = await get('/api/attendance/status'); drawClock(); drawHistory(); if (app.user.is_admin) drawToday();
      } catch (e) {
        err.textContent = e.message; err.hidden = false; submit.textContent = status.next === 'in' ? 'Clock in' : 'Clock out'; refreshSubmit();
      }
    });

    ref = openDialog([dlgHead(status.next === 'in' ? 'Clock in' : 'Clock out', () => ref),
      camBox, camNote, h('div', { class: 'row', style: { justifyContent: 'center' } }, takeBtn, retake, fallback), fileIn,
      gps, err, h('div', { class: 'dlg-actions' }, submit)], {
      onClose: () => { stream?.getTracks().forEach((t) => t.stop()); if (watchId != null) navigator.geolocation.clearWatch(watchId); },
    });
  }

  // ---------- admin ----------
  const todayBox = h('div', {});
  const reportBox = h('div', {});
  async function drawToday() {
    const d = await get('/api/attendance/today');
    const inN = d.people.filter((p) => p.status === 'in').length, outN = d.people.filter((p) => p.status === 'out').length;
    clear(todayBox).append(
      h('p', { class: 'muted', style: { marginBottom: '10px' } }, `${inN} in the office, ${outN} clocked out, ${d.people.length - inN - outN} not yet seen today.`),
      h('div', { class: 'tbl-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Person', 'Status', 'First in', 'Last activity', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, d.people.map((p) => h('tr', {},
          h('td', {}, p.name),
          h('td', {}, p.status === 'in' ? pill('In', 'ok') : p.status === 'out' ? pill('Out', 'info') : pill('Not yet')),
          h('td', { class: 'num' }, p.first_in ? fmt.time(p.first_in) : '–'),
          h('td', { class: 'num' }, p.last_at ? fmt.time(p.last_at) : '–'),
          h('td', {}, p.last_id ? photoThumb(p.last_id) : null)))))));
  }
  function photoThumb(id) {
    const img = h('img', { class: 'thumb', src: `/api/attendance/${id}/photo`, alt: 'Selfie', loading: 'lazy' });
    return h('button', { class: 'btn link', type: 'button', 'aria-label': 'Enlarge selfie', onclick: () => { let r; r = openDialog([dlgHead('Selfie', () => r), h('img', { src: `/api/attendance/${id}/photo`, alt: 'Selfie' })]); } }, img);
  }

  async function adminPanel() {
    const people = (await get('/api/directory')).people;
    const today = new Date(), weekAgo = new Date(Date.now() - 6 * 86400000);
    const from = h('input', { type: 'date', id: 'rf', value: ymd(weekAgo) }), to = h('input', { type: 'date', id: 'rt', value: ymd(today) });
    const who = h('select', { id: 'rw' }, h('option', { value: '' }, 'Everyone'), people.map((p) => h('option', { value: p.id }, p.name)));
    const csv = h('a', { class: 'btn ghost', href: '#' }, 'Download CSV');
    const setCsv = () => { csv.href = `/api/attendance/export.csv?from=${from.value}&to=${to.value}`; };
    const run = async () => {
      setCsv();
      try {
        const { records } = await get(`/api/attendance/report?from=${from.value}&to=${to.value}${who.value ? '&user_id=' + who.value : ''}`);
        clear(reportBox).append(records.length ? h('div', { class: 'tbl-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'Person', 'Type', 'From office', 'GPS accuracy', ''].map((x) => h('th', {}, x)))),
          h('tbody', {}, records.map((r) => h('tr', {}, h('td', { class: 'num' }, fmt.dateTime(r.at_ms)), h('td', {}, r.user_name), h('td', {}, r.kind === 'in' ? pill('In', 'ok') : pill('Out', 'info')),
            h('td', { class: 'num' }, `${Math.round(r.distance_m)} m`), h('td', { class: 'num' }, `${Math.round(r.accuracy_m)} m`), h('td', {}, photoThumb(r.id))))))) : empty('No records in that range.'));
      } catch (e) { toast(e.message); }
    };
    let mode = 'today';
    const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Admin attendance view' },
      ['today', 'report'].map((k) => h('button', { role: 'tab', 'data-k': k, 'aria-selected': String(k === mode), onclick: () => {
        mode = k; tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.k === k)));
        todayBox.hidden = k !== 'today'; reportPane.hidden = k !== 'report'; if (k === 'report') run();
      } }, k === 'today' ? 'Today' : 'Report')));
    const reportPane = h('div', { hidden: true },
      h('div', { class: 'row', style: { marginBottom: '12px', alignItems: 'flex-end' } },
        h('div', {}, h('label', { for: 'rf' }, 'From'), from), h('div', {}, h('label', { for: 'rt' }, 'To'), to), h('div', {}, h('label', { for: 'rw' }, 'Person'), who),
        h('button', { class: 'btn', onclick: run }, 'Show'), csv), reportBox);
    setCsv();
    adminBox.append(h('h2', { style: { margin: '30px 0 10px' } }, 'Team attendance (admin)'), h('div', { style: { marginBottom: '12px' } }, tabs), todayBox, reportPane);
    await drawToday();
  }

  drawClock();
  await drawHistory();
  if (app.user.is_admin) await adminPanel();
}
