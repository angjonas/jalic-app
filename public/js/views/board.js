import { h, clear, fmt, pill, empty, armButton, formModal, toFormData, toast, media, endOfDay, ymd } from '../ui.js';
import { get, post, patch, del, api } from '../api.js';

const CATS = {
  holiday: ['Holiday', 'ok'], birthday: ['Birthday', 'info'], anniversary: ['Work anniversary', 'info'], promotion: ['Promotion', 'ok'],
  equipment: ['New equipment', ''], repair: ['Under repair', 'warn'], general: ['General', ''],
};

export default async function board(root, app) {
  let filter = 'all';
  const data = await get('/api/board');
  const listBox = h('div', { class: 'stack' });

  const canPost = app.user.can_post;
  root.append(
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Community Board'), h('p', {}, 'Holidays, birthdays, anniversaries, promotions and notices about the office.')),
      canPost ? h('button', { class: 'btn', onclick: () => openForm() }, 'New post') : null),
    comingUp(data),
    h('div', { class: 'row', style: { marginBottom: '14px' } },
      h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Filter posts' },
        [['all', 'All'], ...Object.entries(CATS).map(([k, v]) => [k, v[0]])].map(([k, label]) =>
          h('button', { role: 'tab', 'aria-selected': String(k === filter), onclick: (e) => {
            filter = k; e.currentTarget.parentElement.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b === e.currentTarget))); draw();
          } }, label)))),
    listBox);

  function comingUp(d) {
    if (!d.birthdays.length && !d.anniversaries.length) return h('div', {});
    const when = (n) => (n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : `In ${n} days`);
    const box = (title, rows, line) => h('div', { class: 'panel' }, h('h3', {}, title),
      rows.length ? h('ul', {}, rows.map((r) => h('li', {}, h('span', {}, line(r)), h('span', { class: r.days_away === 0 ? '' : 'muted small' }, r.days_away === 0 ? pill('Today', 'ok') : when(r.days_away))))) : h('p', { class: 'muted small' }, 'Nothing in the next two weeks.'));
    return h('div', { class: 'upcoming' },
      box('Birthdays coming up', d.birthdays, (r) => `${r.name} · ${fmt.monthDay(r.month_day)}`),
      box('Work anniversaries', d.anniversaries, (r) => `${r.name} · ${r.years} ${r.years === 1 ? 'year' : 'years'}`));
  }

  function draw() {
    clear(listBox);
    const posts = data.posts.filter((p) => filter === 'all' || p.category === filter);
    if (!posts.length) { listBox.append(empty(filter === 'all' ? 'No announcements yet.' : 'No posts in this category.')); return; }
    for (const p of posts) listBox.append(postCard(p));
  }

  function postCard(p) {
    const [label, tone] = CATS[p.category];
    const mine = app.user.is_admin || p.created_by === app.user.id;
    return h('article', { class: 'post' + (p.pinned ? ' pinned' : '') },
      p.image ? h('img', { class: 'hero', src: media(p.image), alt: '', loading: 'lazy' }) : null,
      h('div', { class: 'post-body' },
        h('div', { class: 'row' }, pill(label, tone), p.pinned ? pill('Pinned', 'ok') : null, h('span', { class: 'small muted' }, `${p.created_by_name} · ${fmt.ago(p.created_at)}`)),
        h('h2', {}, p.title),
        p.body ? h('p', { class: 'note' }, p.body) : null,
        mine ? h('div', { class: 'row' },
          h('button', { class: 'btn ghost sm', onclick: () => openForm(p) }, 'Edit'),
          h('button', { class: 'btn ghost sm', onclick: async () => { await patch('/api/board/' + p.id, { pinned: !p.pinned }); await reload(); } }, p.pinned ? 'Unpin' : 'Pin to top'),
          armButton('Delete', async () => { await del('/api/board/' + p.id); toast('Post deleted.'); await reload(); })) : null));
  }

  function openForm(p) {
    formModal({
      title: p ? 'Edit post' : 'New post', submitLabel: p ? 'Save' : 'Post',
      initial: p ? { ...p, image: media(p.image), hide_after: p.expires_at ? ymd(new Date(p.expires_at)) : '' } : { category: 'general' },
      fields: [
        { name: 'category', label: 'Category', type: 'select', required: true, options: Object.entries(CATS).map(([value, v]) => ({ value, label: v[0] })) },
        { name: 'title', label: 'Headline', type: 'text', required: true, max: 140 },
        { name: 'body', label: 'Message', type: 'textarea', max: 4000 },
        { name: 'image', label: 'Photo', type: 'image' },
        { name: 'hide_after', label: 'Hide after', type: 'date', hint: 'Leave empty to keep it up until you delete it.' },
        { name: 'pinned', label: 'Pin to the top of the board', type: 'checkbox' },
      ],
      onSubmit: async (v) => {
        const { hide_after, ...rest } = v;
        const body = { ...rest, expires_at: hide_after ? endOfDay(hide_after) : '' };
        if (p) await api('PATCH', '/api/board/' + p.id, toFormData(body)); else await api('POST', '/api/board', toFormData(body));
        toast(p ? 'Post updated.' : 'Posted.');
        await reload();
      },
    });
  }

  async function reload() {
    const fresh = await get('/api/board');
    data.posts = fresh.posts; data.birthdays = fresh.birthdays; data.anniversaries = fresh.anniversaries;
    draw();
  }
  draw();
}
