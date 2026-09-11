/* Sessions and request plumbing for the Vercel deployment.
 *
 * The cookie format is byte-for-byte the one the container build issues: `<uid>:<expiry>:<version>`
 * plus an HMAC-SHA256 tag. The difference is where the key comes from — there is no writable disk
 * on Vercel, so it must be supplied as SESSION_SECRET. If it were generated per invocation, every
 * request would land on a different key and nobody could ever stay signed in.
 */
import crypto from 'node:crypto';
import * as store from './store.js';

const SECRET = process.env.SESSION_SECRET || '';
export const ORIGIN = process.env.ORIGIN || '';
export const SESSION_DAYS = Math.max(1, +(process.env.SESSION_DAYS || 90) || 90);
export const ADMIN_UIDS = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
export const INVITE_ONLY = /^(1|true|yes|on)$/i.test(process.env.INVITE_ONLY || '');
export const MIN_PASSWORD = 8;

// Vercel always serves over HTTPS, so the cookie is Secure unless ORIGIN explicitly says http
// (which only happens when someone points this at a local test server).
const SECURE = /^http:/i.test(ORIGIN) ? '' : ' Secure;';

export const secretMissing = () => !SECRET || SECRET.length < 32;

export const isAdmin = user => !!user && (user.admin === true || ADMIN_UIDS.includes(user.id));
export const publicUser = user => ({ id: user.id, name: user.name, admin: isAdmin(user) });

function sign(payload) {
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + mac;
}
function verifySig(token) {
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i), mac = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  } catch { return null; }
  return payload;
}

const sessionVersion = user => user.sv || 0;

export function sessionCookie(user) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const tok = sign(user.id + ':' + exp + ':' + sessionVersion(user));
  return `gymsid=${tok}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly;${SECURE} SameSite=Lax`;
}
export const clearCookie = `gymsid=; Path=/; Max-Age=0; HttpOnly;${SECURE} SameSite=Lax`;

/**
 * Resolve the caller, or null. Async here (it is synchronous in the container build) because the
 * profile has to be fetched per request rather than read from a cache.
 */
export async function readSession(req) {
  if (secretMissing()) return null;
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => {
    const i = c.indexOf('='); return i < 0 ? ['', ''] : [c.slice(0, i).trim(), c.slice(i + 1).trim()];
  }));
  const tok = cookies.gymsid;
  if (!tok) return null;
  const payload = verifySig(tok);
  if (!payload) return null;
  const [uid, exp, ver] = payload.split(':');
  if (!uid || +exp < Date.now()) return null;
  const user = await store.profile(uid);
  if (!user) return null;
  if (user.disabled) return null;
  const claimed = ver === undefined ? 0 : Number(ver);
  if (!Number.isInteger(claimed) || claimed !== sessionVersion(user)) return null;
  return user;
}

/* ---------- http helpers ---------- */

export function json(res, code, obj, extraHeaders) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(extraHeaders || {}) });
  res.end(JSON.stringify(obj));
}

const MAX_BODY = 5 * 1024 * 1024;

/**
 * Vercel's Node helpers usually parse JSON into req.body already; fall back to reading the stream
 * for anything they didn't (a sendBeacon Blob, for instance, arrives with an odd content type).
 */
export function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') { try { return Promise.resolve(JSON.parse(req.body || '{}')); } catch { return Promise.reject(new Error('bad json')); } }
    if (typeof req.body === 'object') return Promise.resolve(req.body);
  }
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', d => {
      size += d.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

/** Guard for /api/admin/* — resolves the caller and 401/403s if they aren't an admin. */
export async function requireAdmin(req, res) {
  const user = await readSession(req);
  if (!user) { json(res, 401, { error: 'not signed in' }); return null; }
  if (!isAdmin(user)) { json(res, 403, { error: 'forbidden' }); return null; }
  return user;
}

// Deliberately loose: Supabase does the real validation.
export const emailOK = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
