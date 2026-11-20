import { bad, detectImage } from './util.js';

// Cover art is only ever downloaded from these hosts (SSRF guard), and every redirect hop is re-checked.
const ALLOWED_HOSTS = ['openlibrary.org', 'archive.org', 'wikimedia.org', 'wikipedia.org'];
const UA = 'OfficeManager/1.0 (internal office tool; contact: office admin)';
const MAX_BYTES = 6 * 1024 * 1024;

export function hostAllowed(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && ALLOWED_HOSTS.some((h) => x.hostname === h || x.hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Lookup failed (${res.status})`);
  return res.json();
}

async function searchBooks(q, fetchImpl) {
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=10&fields=title,author_name,cover_i,first_publish_year`;
  const data = await getJson(url, fetchImpl);
  return (data.docs || [])
    .filter((d) => d.cover_i)
    .slice(0, 8)
    .map((d) => ({
      title: d.title,
      creator: (d.author_name || [])[0] || '',
      year: d.first_publish_year || null,
      image: `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`,
      thumb: `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg`,
      source: 'Open Library',
    }));
}

async function searchWikipedia(q, suffix, fetchImpl) {
  const term = suffix ? `${q} ${suffix}` : q;
  const url =
    'https://en.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=0&gsrlimit=8' +
    `&gsrsearch=${encodeURIComponent(term)}&prop=pageimages|description&piprop=thumbnail&pithumbsize=600`;
  const data = await getJson(url, fetchImpl);
  const pages = Object.values(data?.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  return pages
    .filter((p) => p.thumbnail?.source)
    .map((p) => ({
      title: p.title,
      creator: p.description || '',
      year: null,
      image: p.thumbnail.source,
      thumb: p.thumbnail.source,
      source: 'Wikipedia',
    }));
}

export async function searchCovers(kind, q, fetchImpl = fetch) {
  const query = String(q || '').trim();
  if (query.length < 2) throw bad('Type at least two letters to search.');
  if (kind === 'book') {
    const books = await searchBooks(query, fetchImpl);
    if (books.length) return books;
    return searchWikipedia(query, 'book', fetchImpl);
  }
  if (kind === 'boardgame') return searchWikipedia(query, 'board game', fetchImpl);
  if (kind === 'console') return searchWikipedia(query, 'video game console', fetchImpl);
  return searchWikipedia(query, '', fetchImpl);
}

export async function downloadImage(url, fetchImpl = fetch) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    if (!hostAllowed(current)) throw new Error('Cover images can only come from Open Library or Wikipedia. Upload a file instead.');
    const res = await fetchImpl(current, { redirect: 'manual', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).toString();
      continue;
    }
    if (!res.ok) throw new Error(`Image download failed (${res.status})`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_BYTES) throw new Error('That image is too large.');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('That image is too large.');
    if (!detectImage(buf)) throw new Error('That link is not a supported image.');
    return buf;
  }
  throw new Error('Too many redirects.');
}
