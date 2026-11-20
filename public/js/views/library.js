import { h, clear, fmt, pill, empty, armButton, formModal, toFormData, toast, media } from '../ui.js';
import { get, post, api } from '../api.js';

const KINDS = { book: 'Books', boardgame: 'Board games', console: 'Game consoles', other: 'Other' };
const KIND_ONE = { book: 'Book', boardgame: 'Board game', console: 'Game console', other: 'Other' };

export default async function library(root, app) {
  let items = (await get('/api/library')).items;
  let kind = 'all', q = '';
  const grid = h('div', { class: 'cards' });
  const search = h('input', { type: 'search', placeholder: 'Search title or author', 'aria-label': 'Search the library', oninput: () => { q = search.value.trim().toLowerCase(); draw(); } });
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Type' },
    [['all', 'All'], ...Object.entries(KINDS)].map(([k, l]) => h('button', { role: 'tab', 'data-k': k, 'aria-selected': String(k === kind), onclick: () => {
      kind = k; tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.k === k))); draw();
    } }, l)));

  root.append(
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Library'), h('p', {}, 'Books, board games and game consoles you can borrow. Tap Borrow, pick it up, and return it when you are done.')),
      app.user.is_admin ? h('button', { class: 'btn', onclick: () => openForm() }, 'Add an item') : null),
    h('div', { class: 'row', style: { marginBottom: '14px', justifyContent: 'space-between' } }, tabs, h('div', { style: { width: '260px', maxWidth: '100%' } }, search)),
    grid);

  const due = (l) => `Due ${fmt.dateShort(l.due_at)}`;

  function card(it) {
    const mineLoan = it.loan && it.loan.user_id === app.user.id;
    const overdue = it.loan && it.loan.due_at < Date.now();
    const acts = h('div', { class: 'card-actions' });
    const run = (fn, msg) => async () => { try { await fn(); toast(msg); await reload(); } catch (e) { toast(e.message); } };
    if (!it.loan) acts.append(h('button', { class: 'btn sm', onclick: run(() => post(`/api/library/${it.id}/borrow`), 'Borrowed. Enjoy!') }, 'Borrow'));
    else if (mineLoan || app.user.is_admin) acts.append(h('button', { class: 'btn ghost sm', onclick: run(() => post(`/api/library/${it.id}/return`), 'Marked as returned.') }, mineLoan ? 'Return it' : 'Mark returned'));
    if (app.user.is_admin) acts.append(h('button', { class: 'btn ghost sm', onclick: () => openForm(it) }, 'Edit'),
      armButton('Remove', run(() => api('DELETE', '/api/library/' + it.id), 'Removed.')));
    return h('article', { class: 'card' },
      h('div', { class: 'cover' + (it.kind === 'boardgame' ? ' sq' : '') }, it.cover ? h('img', { src: media(it.cover), alt: `Cover of ${it.title}`, loading: 'lazy' }) : h('span', { 'aria-hidden': 'true' }, it.title.slice(0, 1).toUpperCase())),
      h('div', { class: 'card-body' },
        h('h3', {}, it.title),
        it.creator ? h('p', { class: 'small muted' }, it.creator) : null,
        h('div', { class: 'row' }, pill(KIND_ONE[it.kind]),
          it.loan ? pill(overdue ? 'Overdue' : 'On loan', overdue ? 'crit' : 'warn') : pill('Available', 'ok')),
        it.loan ? h('p', { class: 'small muted' }, `${mineLoan ? 'You have it' : it.loan.user_name + ' has it'} · ${due(it.loan)}`) : null,
        it.description ? h('p', { class: 'small' }, it.description) : null),
      acts);
  }

  function draw() {
    const rows = items.filter((i) => (kind === 'all' || i.kind === kind) && (!q || `${i.title} ${i.creator || ''}`.toLowerCase().includes(q)));
    clear(grid);
    if (!rows.length) { grid.className = ''; grid.append(empty(items.length ? 'Nothing matches that search.' : app.user.is_admin ? 'The library is empty. Add the first item.' : 'The library has no items yet.')); return; }
    grid.className = 'cards';
    rows.forEach((i) => grid.append(card(i)));
  }

  async function reload() { items = (await get('/api/library')).items; draw(); }

  function coverPicker({ get: getField, initial }) {
    let chosen = '';
    const results = h('div', { class: 'cover-pick' });
    const msg = h('p', { class: 'hint' }, 'Search the internet for cover art, or upload your own photo below.');
    const btn = h('button', { class: 'btn ghost sm', type: 'button' }, 'Find cover art');
    btn.addEventListener('click', async () => {
      const title = getField('title'), k = getField('kind');
      if (!title) { msg.textContent = 'Type the title first.'; return; }
      btn.disabled = true; msg.textContent = 'Searching…'; clear(results); chosen = '';
      try {
        const r = await get(`/api/library/cover-search?kind=${encodeURIComponent(k)}&q=${encodeURIComponent(title)}`);
        msg.textContent = r.results.length ? 'Tap the right cover.' : 'No covers found. Try a shorter title, or upload a photo.';
        for (const c of r.results) {
          const b = h('button', { type: 'button', 'aria-pressed': 'false', title: `${c.title}${c.creator ? ' · ' + c.creator : ''} (${c.source})`, onclick: () => {
            chosen = chosen === c.image ? '' : c.image;
            results.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
            if (chosen) b.setAttribute('aria-pressed', 'true');
          } }, h('img', { src: '/api/library/cover-preview?url=' + encodeURIComponent(c.thumb || c.image), alt: c.title, loading: 'lazy' }));
          results.append(b);
        }
      } catch (e) { msg.textContent = e.message; } finally { btn.disabled = false; }
    });
    const note = initial.cover ? h('p', { class: 'hint' }, 'The current cover is kept unless you pick or upload a new one.') : null;
    return { node: h('div', {}, h('span', { class: 'lbl' }, 'Cover art'), btn, msg, results, note), read: () => chosen };
  }

  function openForm(it) {
    formModal({
      title: it ? 'Edit item' : 'Add an item', submitLabel: it ? 'Save' : 'Add to library', wide: true,
      initial: it ? { ...it, image: null } : { kind: 'book' },
      fields: [
        { name: 'kind', label: 'Type', type: 'select', required: true, options: Object.entries(KIND_ONE).map(([value, label]) => ({ value, label })) },
        { name: 'title', label: 'Title', type: 'text', required: true, max: 120 },
        { name: 'creator', label: 'Author or maker', type: 'text', max: 120 },
        { name: 'description', label: 'Description', type: 'textarea', max: 600 },
        { name: 'cover_url', label: 'Cover art', type: 'custom', custom: (api2) => coverPicker({ ...api2, initial: it || {} }) },
        { name: 'image', label: 'Or upload your own photo', type: 'image' },
      ],
      onSubmit: async (v) => {
        const body = toFormData(v);
        const r = it ? await api('PATCH', '/api/library/' + it.id, body) : await api('POST', '/api/library', body);
        toast(r.cover_error ? `Saved, but the cover could not be fetched: ${r.cover_error}` : it ? 'Item updated.' : 'Added to the library.');
        await reload();
      },
    });
  }
  draw();
}
