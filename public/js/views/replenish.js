import { h, clear, fmt, pill, empty, armButton, toast } from '../ui.js';
import { get, post, patch, del } from '../api.js';

const URG = { normal: 'When convenient', low: 'Running low', out: 'Out now' };
const URG_W = { normal: 0, low: 1, out: 2 };
const ST = { requested: 'Requested', ordered: 'Ordered', restocked: 'Restocked', declined: 'Declined' };

export default async function replenish(root, app) {
  const [cat, reqs] = await Promise.all([get('/api/supply/catalog'), get('/api/supply/requests')]);
  let requests = reqs.requests;
  const catalog = cat.items;
  const S = { tab: 'active', view: 'list' };
  const isActive = (r) => r.status === 'requested' || r.status === 'ordered';

  // ----- form -----
  const itemSel = h('select', { id: 'item', required: true }, h('option', { value: '', disabled: true, selected: true }, 'Choose a supply'));
  const groups = {};
  for (const c of catalog) (groups[c.category] ||= []).push(c);
  for (const [g, items] of Object.entries(groups)) itemSel.append(h('optgroup', { label: g }, items.map((i) => h('option', { value: i.name }, i.name))));
  itemSel.append(h('option', { value: '__other' }, 'Something else'));
  const other = h('input', { id: 'other', type: 'text', maxlength: 80, placeholder: 'e.g. Whiteboard markers, black' });
  const otherWrap = h('div', { hidden: true }, h('label', { for: 'other' }, 'Describe the item'), other);
  const qty = h('input', { id: 'qty', type: 'number', min: 1, max: 999, step: 1, value: 1, inputmode: 'numeric' });
  const units = ['pcs', 'packs', 'boxes', 'reams', 'rolls', 'bottles', 'kg', 'cans', 'jugs', 'pads'];
  const unit = h('select', { id: 'unit' }, units.map((u) => h('option', { value: u }, u)));
  const note = h('textarea', { id: 'note', maxlength: 300, placeholder: 'Brand, location, anything the buyer should know' });
  const hint = h('div', { class: 'banner', hidden: true });
  const send = h('button', { class: 'btn', type: 'submit' }, 'Send request');
  const urgRadios = Object.entries(URG).map(([v, l]) => h('label', {}, h('input', { type: 'radio', name: 'urg', value: v, checked: v === 'normal' }), h('span', {}, l)));

  itemSel.addEventListener('change', () => {
    otherWrap.hidden = itemSel.value !== '__other';
    const c = catalog.find((i) => i.name === itemSel.value);
    if (c) unit.value = c.unit;
    const n = requests.filter((r) => r.item === itemSel.value && isActive(r)).length;
    hint.hidden = !n;
    if (n) hint.textContent = n === 1 ? 'Someone already asked for this and it is still open. Tap Me too on their request instead.' : `${n} open requests already exist for this. Tap Me too on one of them instead.`;
  });

  const form = h('form', { class: 'form', novalidate: true },
    h('div', {}, h('label', { for: 'item' }, 'What do we need?'), itemSel), otherWrap, hint,
    h('div', { class: 'row2' }, h('div', {}, h('label', { for: 'qty' }, 'How many?'), qty), h('div', {}, h('label', { for: 'unit' }, 'Unit'), unit)),
    h('div', {}, h('span', { class: 'lbl' }, 'How soon?'), h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'How soon' }, urgRadios)),
    h('div', {}, h('label', { for: 'note' }, 'Note ', h('span', { class: 'muted' }, '(optional)')), note), send);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const item = itemSel.value === '__other' ? other.value.trim() : itemSel.value;
    if (!item) { toast('Choose a supply, or describe what you need.'); return; }
    send.disabled = true;
    try {
      await post('/api/supply/requests', { item, unit: unit.value, qty: Number(qty.value) || 1, urgency: form.querySelector('input[name=urg]:checked').value, note: note.value });
      form.reset(); otherWrap.hidden = true; hint.hidden = true;
      toast('Request sent. The office manager can see it now.');
      await reload();
    } catch (err) { toast(err.message); } finally { send.disabled = false; }
  });

  // ----- list -----
  const strip = h('div', { class: 'row muted small', style: { gap: '4px 16px', marginBottom: '12px' } });
  const out = h('div', {});
  const tabBtn = (k, l, kind) => h('button', { role: 'tab', 'data-k': k, 'aria-selected': String((kind === 'tab' ? S.tab : S.view) === k),
    onclick: () => { S[kind] = k; sync(); draw(); } }, l);
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Filter' }, tabBtn('active', 'Active', 'tab'), tabBtn('done', 'Done', 'tab'), tabBtn('all', 'All', 'tab'));
  const views = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'View' }, tabBtn('list', 'Requests', 'view'), tabBtn('shop', 'Shopping list', 'view'));
  function sync() {
    tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.k === S.tab)));
    views.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.k === S.view)));
    tabs.hidden = S.view === 'shop';
  }

  async function act(fn) { try { await fn(); await reload(); } catch (e) { toast(e.message); } }

  function row(r) {
    const mine = r.user_id === app.user.id;
    const acts = h('div', { class: 'row' });
    if (!mine && isActive(r)) acts.append(h('button', { class: 'btn ghost sm', 'aria-pressed': String(r.i_metoo), onclick: () => act(() => post(`/api/supply/requests/${r.id}/metoo`)) }, r.i_metoo ? 'You asked too' : 'Me too'));
    if (app.user.is_admin) {
      const set = (s) => () => act(() => patch('/api/supply/requests/' + r.id, { status: s }));
      if (r.status === 'requested') acts.append(h('button', { class: 'btn sm', onclick: set('ordered') }, 'Mark ordered'), h('button', { class: 'btn ghost sm', onclick: set('declined') }, 'Decline'));
      else if (r.status === 'ordered') acts.append(h('button', { class: 'btn sm', onclick: set('restocked') }, 'Mark restocked'), h('button', { class: 'btn ghost sm', onclick: set('requested') }, 'Back to requested'));
      else acts.append(h('button', { class: 'btn ghost sm', onclick: set('requested') }, 'Reopen'));
      acts.append(armButton('Delete', () => act(() => del('/api/supply/requests/' + r.id))));
    } else if (mine && r.status === 'requested') acts.append(armButton('Cancel', () => act(() => del('/api/supply/requests/' + r.id))));
    return h('li', {},
      h('div', { class: 'grow' },
        h('div', { class: 'title-row' }, h('strong', {}, r.item), h('span', { class: 'muted num' }, `× ${r.qty} ${r.unit}`)),
        h('div', { class: 'meta' },
          r.status !== 'requested' ? pill(ST[r.status], r.status === 'ordered' ? 'info' : r.status === 'restocked' ? 'ok' : 'strike') : null,
          r.urgency !== 'normal' ? pill(URG[r.urgency], r.urgency === 'out' ? 'crit' : 'warn') : null,
          h('span', {}, `${mine ? 'You' : r.user_name} · ${fmt.ago(r.created_at)}`),
          r.metoo_count ? h('span', {}, `+${r.metoo_count} also asked`) : null),
        r.note ? h('p', { class: 'note' }, r.note) : null,
        r.status_note ? h('p', { class: 'note muted' }, 'Office manager: ' + r.status_note) : null),
      acts);
  }

  function shopList() {
    const groupsMap = {};
    for (const r of requests) {
      if (r.status !== 'requested') continue;
      const g = (groupsMap[r.item.toLowerCase() + '|' + r.unit] ||= { item: r.item, unit: r.unit, qty: 0, ids: [], people: new Set(), w: 0 });
      g.qty += r.qty; g.ids.push(r.id); g.people.add(r.user_id); g.w = Math.max(g.w, URG_W[r.urgency]);
    }
    const rows = Object.values(groupsMap).sort((a, b) => b.w - a.w || a.item.localeCompare(b.item));
    if (!rows.length) return empty('Nothing to buy right now. New requests are totalled here by item.');
    const text = rows.map((g) => `${g.item}: ${g.qty} ${g.unit}`).join('\n');
    return h('div', {},
      h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '10px' } },
        h('span', { class: 'muted' }, `${rows.length} ${rows.length === 1 ? 'item' : 'items'} to buy`),
        h('button', { class: 'btn ghost sm', onclick: () => navigator.clipboard?.writeText(text).then(() => toast('List copied.'), () => toast('Copy is not available here.')) }, 'Copy list')),
      h('ul', { class: 'list' }, rows.map((g) => h('li', {},
        h('div', { class: 'grow' },
          h('div', { class: 'title-row' }, h('strong', {}, g.item), h('span', { class: 'muted num' }, `${g.qty} ${g.unit}`)),
          h('div', { class: 'meta' }, g.w ? pill(g.w === 2 ? 'Out now' : 'Running low', g.w === 2 ? 'crit' : 'warn') : null,
            h('span', {}, `${g.ids.length} ${g.ids.length === 1 ? 'request' : 'requests'} from ${g.people.size} ${g.people.size === 1 ? 'person' : 'people'}`))),
        app.user.is_admin ? h('button', { class: 'btn sm', onclick: (e) => { e.currentTarget.disabled = true; act(async () => { for (const id of g.ids) await patch('/api/supply/requests/' + id, { status: 'ordered' }); }); } }, 'Mark all ordered') : null))));
  }

  function draw() {
    const waiting = requests.filter((r) => r.status === 'requested').length;
    const ordered = requests.filter((r) => r.status === 'ordered').length;
    const outNow = requests.filter((r) => isActive(r) && r.urgency === 'out').length;
    clear(strip).append(h('span', {}, h('b', {}, waiting), ' waiting'), h('span', {}, h('b', {}, ordered), ' ordered'), h('span', {}, h('b', {}, outNow), ' out now'));
    clear(out);
    if (S.view === 'shop') { out.append(shopList()); return; }
    const rows = requests.filter((r) => S.tab === 'all' || (S.tab === 'active' ? isActive(r) : !isActive(r)))
      .sort((a, b) => (S.tab === 'active' ? URG_W[b.urgency] - URG_W[a.urgency] : 0) || b.created_at - a.created_at);
    if (!rows.length) out.append(empty(S.tab === 'active' ? 'Nothing waiting. When something runs low, send a request from the form.' : S.tab === 'done' ? 'Restocked and declined requests show up here.' : 'No requests yet.'));
    else out.append(h('ul', { class: 'list' }, rows.map(row)));
  }

  async function reload() { requests = (await get('/api/supply/requests')).requests; draw(); }

  root.append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Replenish'), h('p', {}, 'Running low on something? Ask for it here. Everyone sees the same list, and the office manager restocks from it.'))),
    h('div', { class: 'split' },
      h('section', { class: 'panel', 'aria-label': 'New request' }, h('h2', {}, 'New request'), h('div', { style: { marginTop: '14px' } }, form)),
      h('section', { 'aria-label': 'Requests' }, strip, h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '12px' } }, tabs, views), out)));
  sync(); draw();
}
