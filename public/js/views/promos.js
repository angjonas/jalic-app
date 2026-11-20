import { h, clear, fmt, pill, empty, armButton, formModal, toFormData, toast, media, endOfDay, ymd } from '../ui.js';
import { get, post, api } from '../api.js';

export default async function promos(root, app) {
  let list = (await get('/api/promos')).promos;
  const box = h('div', { class: 'cards' });
  const canPost = app.user.can_post;

  root.append(
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Promos'), h('p', {}, 'Employee-only deals on products the company sells. No online payment here: use the contact shown on each promo to buy.')),
      canPost ? h('button', { class: 'btn', onclick: () => openForm() }, 'New promo') : null),
    box);

  const expired = (p) => p.valid_until && p.valid_until < Date.now();

  function card(p) {
    const mine = app.user.is_admin || p.created_by === app.user.id;
    const off = p.original_price && p.original_price > p.price ? Math.round((1 - p.price / p.original_price) * 100) : 0;
    const run = (fn, msg) => async () => { try { await fn(); if (msg) toast(msg); await reload(); } catch (x) { toast(x.message); } };
    return h('article', { class: 'card' },
      h('div', { class: 'cover sq' }, p.image ? h('img', { src: media(p.image), alt: `${p.brand} ${p.title}`, loading: 'lazy' }) : h('span', { 'aria-hidden': 'true' }, p.brand.slice(0, 1).toUpperCase())),
      h('div', { class: 'card-body' },
        h('div', { class: 'row' }, pill(p.brand, 'info'), off ? pill(`${off}% off`, 'ok') : null, expired(p) ? pill('Ended', 'crit') : null),
        h('h3', {}, p.title),
        h('p', { class: 'price' }, fmt.money(p.price), p.original_price ? h('s', {}, fmt.money(p.original_price)) : null),
        p.valid_until ? h('p', { class: 'small muted' }, `${expired(p) ? 'Ended' : 'Until'} ${fmt.dateShort(p.valid_until)}`) : null,
        p.description ? h('p', { class: 'small' }, p.description) : null,
        p.how_to_buy ? h('p', { class: 'small' }, h('strong', {}, 'How to buy: '), p.how_to_buy) : null),
      h('div', { class: 'card-actions' },
        !expired(p) ? h('button', { class: 'btn sm', 'aria-pressed': String(p.i_interested), onclick: run(() => post(`/api/promos/${p.id}/interest`)) }, p.i_interested ? "You're interested" : "I'm interested") : null,
        h('span', { class: 'small muted' }, `${p.interest_count} interested`),
        mine ? [h('button', { class: 'btn ghost sm', onclick: () => openForm(p) }, 'Edit'), armButton('Delete', run(() => api('DELETE', '/api/promos/' + p.id), 'Promo deleted.'))] : null));
  }

  function draw() {
    clear(box);
    if (!list.length) { box.className = ''; box.append(empty(canPost ? 'No promos yet. Post the first deal.' : 'No promos right now. Check back soon.')); return; }
    box.className = 'cards';
    list.forEach((p) => box.append(card(p)));
  }
  async function reload() { list = (await get('/api/promos')).promos; draw(); }

  function openForm(p) {
    formModal({
      title: p ? 'Edit promo' : 'New promo', submitLabel: p ? 'Save' : 'Publish promo',
      initial: p ? { ...p, image: media(p.image), valid_until: p.valid_until ? ymd(new Date(p.valid_until)) : '' } : {},
      fields: [
        { name: 'brand', label: 'Brand', type: 'text', required: true, max: 60, placeholder: 'e.g. Anta' },
        { name: 'title', label: 'Product', type: 'text', required: true, max: 120, placeholder: 'e.g. KT9 basketball shoes' },
        { name: 'price', label: 'Employee price (PHP)', type: 'number', required: true, min: 0, step: '0.01' },
        { name: 'original_price', label: 'Regular price (PHP)', type: 'number', min: 0, step: '0.01', hint: 'Shown crossed out, with the percent saved.' },
        { name: 'valid_until', label: 'Valid until', type: 'date' },
        { name: 'how_to_buy', label: 'How to buy', type: 'text', max: 300, placeholder: 'e.g. Message Liza at the front desk, pay on pickup' },
        { name: 'description', label: 'Details', type: 'textarea', max: 1000 },
        { name: 'image', label: 'Product photo', type: 'image' },
      ],
      onSubmit: async (v) => {
        const { valid_until, ...rest } = v;
        const body = toFormData({ ...rest, valid_until: valid_until ? endOfDay(valid_until) : '' });
        if (p) await api('PATCH', '/api/promos/' + p.id, body); else await api('POST', '/api/promos', body);
        toast(p ? 'Promo updated.' : 'Promo published.');
        await reload();
      },
    });
  }
  draw();
}
