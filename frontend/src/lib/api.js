// Backend helpers. Accounts are Supabase Auth (email + password) behind the openGym API — the
// browser holds no Supabase key and never talks to Supabase directly, so this stays a plain
// same-origin fetch against /api and the session is the server's own HttpOnly cookie.
export const IS_APPLE = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent)
export const IS_ANDROID = /Android/.test(navigator.userAgent)

export async function api(path, opts) {
  const r = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts))
  const data = await r.json().catch(() => ({}))
  if (!r.ok) { const e = new Error(data.error || ('HTTP ' + r.status)); e.status = r.status; throw e }
  return data
}

export async function registerAccount({ name, email, password, code }) {
  const res = await api('/api/register', {
    method: 'POST',
    body: JSON.stringify({ name, email, password, code: code || '' })
  })
  return res.user
}

export async function loginAccount({ email, password }) {
  const res = await api('/api/login', { method: 'POST', body: JSON.stringify({ email, password }) })
  return res.user
}

// The current password is required as well as the cookie — see the route's own note on why.
export async function changePassword({ current, password }) {
  await api('/api/password', { method: 'POST', body: JSON.stringify({ current, password }) })
}
