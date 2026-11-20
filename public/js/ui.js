// Small DOM helpers shared by every view. No framework, no build step.
// Note: the page's Content-Security-Policy forbids inline style attributes, so styling goes through classes or el.style.

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const clear = (el) => { el.replaceChildren(); return el; };
// Like el.append, but skips null/false and accepts nested arrays (the native method would print the word "null").
export const mount = (el, ...kids) => { el.append(...kids.flat(Infinity).filter((k) => k != null && k !== false)); return el; };

let toastTimer;
export function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3600);
}

// ---------- formatting ----------
const dFmt = (o) => (ms) => new Date(ms).toLocaleDateString(undefined, o);
export const fmt = {
  date: dFmt({ weekday: 'short', month: 'short', day: 'numeric' }),
  dateLong: dFmt({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
  dateShort: dFmt({ month: 'short', day: 'numeric' }),
  time: (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
  dateTime: (ms) => `${fmt.date(ms)}, ${fmt.time(ms)}`,
  ago(ms) {
    const m = Math.floor((Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const hr = Math.floor(m / 60);
    if (hr < 24) return `${hr} h ago`;
    const d = Math.floor(hr / 24);
    if (d < 7) return `${d} d ago`;
    return fmt.dateShort(ms);
  },
  money: (n) => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', maximumFractionDigits: n % 1 ? 2 : 0 }).format(n),
  monthDay(md) { const [m, d] = md.split('-').map(Number); return new Date(2024, m - 1, d).toLocaleDateString(undefined, { month: 'long', day: 'numeric' }); },
};
export const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const toLocalInput = (ms) => { const d = new Date(ms); return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const fromLocalInput = (s) => (s ? new Date(s).getTime() : null);
export const endOfDay = (dateStr) => new Date(dateStr + 'T23:59:59').getTime();
export const atLocal = (dateStr, timeStr) => new Date(`${dateStr}T${timeStr}:00`).getTime();

export const media = (name) => (name ? '/media/' + name : null);

export function pill(text, tone = '') { return h('span', { class: 'pill ' + tone }, text); }
export function empty(msg) { return h('p', { class: 'empty' }, msg); }

// A button that needs a second tap to confirm (dialogs are blocked in many embedded browsers, so we avoid confirm()).
export function armButton(label, fn, cls = 'btn link') {
  let timer;
  const b = h('button', { class: cls, type: 'button' }, label);
  b.addEventListener('click', () => {
    if (b.dataset.armed) { clearTimeout(timer); delete b.dataset.armed; b.textContent = label; fn(b); return; }
    b.dataset.armed = '1'; b.textContent = 'Tap again to confirm';
    timer = setTimeout(() => { delete b.dataset.armed; b.textContent = label; }, 3000);
  });
  return b;
}

export async function resizeImage(file, maxDim = 1600, quality = 0.85) {
  if (!file.type.startsWith('image/')) throw new Error('Please choose an image file.');
  if (file.type === 'image/gif') return file;
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw new Error('That image could not be read. Try a JPG or PNG.'); }
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * scale)); c.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('That image could not be processed.'))), 'image/jpeg', quality));
}

export function toFormData(values) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) {
    if (v == null) continue;
    if (v instanceof Blob) fd.append(k, v, v.name || 'image.jpg');
    else if (typeof v === 'boolean') fd.append(k, v ? '1' : '0');
    else fd.append(k, String(v));
  }
  return fd;
}

// ---------- dialogs ----------
export function openDialog(content, { wide = false, onClose } = {}) {
  const dlg = h('dialog', { class: wide ? 'wide' : '' }, h('div', { class: 'dlg' }, content));
  dlg.addEventListener('close', () => { dlg.remove(); onClose && onClose(); });
  document.body.append(dlg);
  dlg.showModal();
  return { el: dlg, close: () => dlg.close() };
}

export function dlgHead(title, dlgRef) {
  return h('div', { class: 'dlg-head' }, h('h2', {}, title),
    h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': 'Close', onclick: () => dlgRef().close() }, 'Close'));
}

// Field spec: { name, label, type, required, options, hint, max, min, step, placeholder, showIf(values), custom(api) }
// types: text email password number textarea select date time datetime checkbox image custom
export function formModal({ title, fields, initial = {}, submitLabel = 'Save', onSubmit, intro, wide = false }) {
  let dlg;
  const ctrls = [];
  const form = h('form', { class: 'form', novalidate: true });
  const errBox = h('div', { class: 'form-error', role: 'alert', hidden: true });

  const current = () => {
    const v = {};
    for (const c of ctrls) if (!c.wrap.hidden) v[c.spec.name] = c.read();
    return v;
  };
  const refresh = () => {
    const v = current();
    for (const c of ctrls) if (c.spec.showIf) c.wrap.hidden = !c.spec.showIf({ ...v, ...Object.fromEntries(ctrls.map((x) => [x.spec.name, x.read()])) });
  };

  for (const spec of fields) {
    const id = 'f_' + spec.name + '_' + Math.random().toString(36).slice(2, 7);
    const init = initial[spec.name];
    let input, read, node;
    const label = spec.label && spec.type !== 'checkbox' ? h('label', { for: id }, spec.label, spec.required ? '' : h('span', { class: 'muted' }, ' (optional)')) : null;
    switch (spec.type) {
      case 'textarea':
        input = h('textarea', { id, maxlength: spec.max, placeholder: spec.placeholder, value: init ?? '' }); read = () => input.value.trim(); node = input; break;
      case 'select': {
        const opts = (spec.options || []).map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
        input = h('select', { id }, opts.map((o) => h('option', { value: o.value }, o.label)));
        input.value = init ?? opts[0]?.value ?? ''; read = () => input.value; node = input; break;
      }
      case 'datetime':
        input = h('input', { id, type: 'datetime-local', value: init ? toLocalInput(init) : '' }); read = () => fromLocalInput(input.value); node = input; break;
      case 'checkbox':
        input = h('input', { id, type: 'checkbox', checked: !!init }); read = () => input.checked;
        node = h('label', { class: 'chk', for: id }, input, spec.label); break;
      case 'image': {
        const prev = h('img', { class: 'thumb', alt: '', hidden: !init, src: init || '' });
        const file = h('input', { id, type: 'file', accept: 'image/*' });
        const rm = init ? h('label', { class: 'chk small' }, h('input', { type: 'checkbox' }), 'Remove current picture') : null;
        let blob = null;
        file.addEventListener('change', async () => {
          blob = null;
          if (!file.files[0]) return;
          try { blob = await resizeImage(file.files[0]); prev.src = URL.createObjectURL(blob); prev.hidden = false; }
          catch (e) { file.value = ''; errBox.textContent = e.message; errBox.hidden = false; }
        });
        input = file; read = () => ({ blob, remove: !!rm?.querySelector('input').checked }); node = h('div', { class: 'row' }, prev, file, rm); break;
      }
      case 'custom': {
        const built = spec.custom({ get: (n) => ctrls.find((c) => c.spec.name === n)?.read(), initial });
        node = built.node; read = built.read; break;
      }
      default:
        input = h('input', { id, type: spec.type || 'text', maxlength: spec.max, min: spec.min, max: spec.type === 'number' ? spec.max : undefined, step: spec.step,
          placeholder: spec.placeholder, autocomplete: spec.type === 'password' ? 'new-password' : 'off', value: init ?? '' });
        read = () => input.value.trim(); node = input;
    }
    const wrap = h('div', {}, label, node, spec.hint ? h('p', { class: 'hint' }, spec.hint) : null);
    ctrls.push({ spec, wrap, read, input });
    form.append(wrap);
  }
  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);

  const submit = h('button', { class: 'btn', type: 'submit' }, submitLabel);
  form.append(errBox, h('div', { class: 'dlg-actions' },
    h('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close() }, 'Cancel'), submit));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errBox.hidden = true;
    const raw = current();
    for (const c of ctrls) {
      if (c.wrap.hidden || !c.spec.required) continue;
      const v = raw[c.spec.name];
      if (v === '' || v == null || v === false) {
        errBox.textContent = `${c.spec.label || c.spec.name} is required.`; errBox.hidden = false; c.input?.focus(); return;
      }
    }
    const values = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v === 'object' && 'blob' in v) { if (v.blob) values[k] = v.blob; if (v.remove && !v.blob) values.remove_image = true; }
      else values[k] = v;
    }
    submit.disabled = true;
    try { await onSubmit(values); dlg.close(); }
    catch (err) { errBox.textContent = err.message || 'That did not work. Try again.'; errBox.hidden = false; }
    finally { submit.disabled = false; }
  });

  const ref = openDialog([dlgHead(title, () => dlg), intro ? h('p', { class: 'muted' }, intro) : null, form], { wide });
  dlg = ref.el;
  refresh();
  ctrls.find((c) => c.input && !c.wrap.hidden && c.spec.type !== 'checkbox')?.input.focus();
  return ref;
}
