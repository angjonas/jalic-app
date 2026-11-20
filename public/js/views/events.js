import { h, clear, fmt, pill, empty, armButton, formModal, toFormData, toast, media } from '../ui.js';
import { get, post, api } from '../api.js';

export default async function events(root, app) {
  let list = (await get('/api/events')).events;
  let showPast = false;
  const box = h('div', { class: 'cards wide' });
  const canPost = app.user.can_post;

  root.append(
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Events'), h('p', {}, 'Community events happening around the office. Tap "I\'m going" so organisers can plan.')),
      h('div', { class: 'row' },
        h('label', { class: 'chk small' }, h('input', { type: 'checkbox', onchange: (e) => { showPast = e.target.checked; draw(); } }), 'Show recent past events'),
        canPost ? h('button', { class: 'btn', onclick: () => openForm() }, 'New event') : null)),
    box);

  const ended = (e) => (e.ends_at || e.starts_at) < Date.now();

  function card(e) {
    const d = new Date(e.starts_at);
    const mine = app.user.is_admin || e.created_by === app.user.id;
    const run = (fn, msg) => async () => { try { await fn(); if (msg) toast(msg); await reload(); } catch (x) { toast(x.message); } };
    return h('article', { class: 'card event' },
      h('div', { class: 'cover wide' }, e.image ? h('img', { src: media(e.image), alt: `Artwork for ${e.title}`, loading: 'lazy' }) : h('span', { 'aria-hidden': 'true' }, '★')),
      h('div', { class: 'card-body' },
        h('div', { class: 'row' },
          h('div', { class: 'datebox' }, h('b', {}, d.getDate()), h('span', {}, d.toLocaleDateString(undefined, { month: 'short' }))),
          h('div', {}, h('h3', {}, e.title), h('p', { class: 'small muted' }, `${fmt.date(e.starts_at)} · ${fmt.time(e.starts_at)}${e.ends_at ? ' to ' + fmt.time(e.ends_at) : ''}`))),
        e.location ? h('p', { class: 'small' }, '📍 ' + e.location) : null,
        e.description ? h('p', { class: 'note' }, e.description) : null,
        ended(e) ? pill('Finished') : null),
      h('div', { class: 'card-actions' },
        !ended(e) ? h('button', { class: 'btn sm', 'aria-pressed': String(e.i_going), onclick: run(() => post(`/api/events/${e.id}/rsvp`)) }, e.i_going ? "You're going" : "I'm going") : null,
        h('span', { class: 'small muted' }, `${e.going_count} going`),
        mine ? [h('button', { class: 'btn ghost sm', onclick: () => openForm(e) }, 'Edit'), armButton('Delete', run(() => api('DELETE', '/api/events/' + e.id), 'Event deleted.'))] : null));
  }

  function draw() {
    const rows = list.filter((e) => showPast || !ended(e));
    clear(box);
    if (!rows.length) { box.className = ''; box.append(empty(canPost ? 'No upcoming events. Post the next one.' : 'No upcoming events right now. Check back soon.')); return; }
    box.className = 'cards wide';
    rows.forEach((e) => box.append(card(e)));
  }

  async function reload() { list = (await get('/api/events')).events; draw(); }

  function openForm(e) {
    formModal({
      title: e ? 'Edit event' : 'New event', submitLabel: e ? 'Save' : 'Publish event',
      initial: e ? { ...e, image: media(e.image) } : {},
      fields: [
        { name: 'title', label: 'Event name', type: 'text', required: true, max: 120, placeholder: 'e.g. Christmas party' },
        { name: 'starts_at', label: 'Starts', type: 'datetime', required: true },
        { name: 'ends_at', label: 'Ends', type: 'datetime' },
        { name: 'location', label: 'Where', type: 'text', max: 120 },
        { name: 'description', label: 'Details', type: 'textarea', max: 2000 },
        { name: 'image', label: 'Artwork', type: 'image', hint: 'A poster or banner. Wide pictures look best.' },
      ],
      onSubmit: async (v) => {
        if (v.ends_at && v.ends_at <= v.starts_at) throw new Error('The event must end after it starts.');
        const body = toFormData({ ...v, ends_at: v.ends_at ?? '' });
        if (e) await api('PATCH', '/api/events/' + e.id, body); else await api('POST', '/api/events', body);
        toast(e ? 'Event updated.' : 'Event published.');
        await reload();
      },
    });
  }
  draw();
}
