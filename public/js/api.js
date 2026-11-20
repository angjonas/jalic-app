export class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data || {}; }
}

export async function api(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(url, opts); }
  catch { throw new ApiError('Cannot reach the server. Check your connection and try again.', 0); }
  let data = null;
  if ((res.headers.get('content-type') || '').includes('json')) data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/login')) window.dispatchEvent(new Event('om:unauth'));
    throw new ApiError(data?.error || `Request failed (${res.status}).`, res.status, data);
  }
  return data;
}
export const get = (u) => api('GET', u);
export const post = (u, b) => api('POST', u, b ?? {});
export const patch = (u, b) => api('PATCH', u, b ?? {});
export const put = (u, b) => api('PUT', u, b ?? {});
export const del = (u) => api('DELETE', u);
