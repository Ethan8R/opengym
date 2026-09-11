/* opengym-api — Supabase Auth (email + password) + per-user state in Supabase Postgres.
   No framework, signed session cookies over Supabase-verified credentials.               */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import * as store from './supabase.js';
import * as coachConfig from './coach/config.js';
import * as coachJobs from './coach/jobs.js';
import { coachRoutes } from './coach/routes.js';
import { startCadence } from './coach/cadence.js';

const PORT = +(process.env.PORT || 3000);
const DATA = process.env.DATA_DIR || '/data';
const ORIGIN = process.env.ORIGIN || 'http://localhost:8080';
// Admin dashboard (issue): admins are matched by uid, OR-ed with the profiles.admin column;
// INVITE_ONLY gates new signups behind a code the admin generates. Both default off so a fresh
// self-hosted instance stays open.
const ADMIN_UIDS = (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
const INVITE_ONLY = /^(1|true|yes|on)$/i.test(process.env.INVITE_ONLY || '');
// 90 days keeps someone who trains a few times a week permanently signed in without a stolen
// cookie staying good for a year. Overridable because a family instance and one on the open
// internet don't want the same number. Only affects cookies minted from now on — the expiry is
// baked into each cookie when it's issued, so lowering this never cuts an existing session short.
const SESSION_DAYS = Math.max(1, +(process.env.SESSION_DAYS || 90) || 90);
const MAX_BODY = 5 * 1024 * 1024;
// Secure cookies require HTTPS; over plain http://localhost the flag would drop the cookie
const SECURE = /^https:/i.test(ORIGIN) ? ' Secure;' : '';
const MIN_PASSWORD = 8;

fs.mkdirSync(DATA, { recursive: true });
// 0700 is what stops the unprivileged user that Coach jobs run as from reading any of this —
// the state mirrors, the session secret, the provider credential. The Agent SDK process gets its
// job payload in a temp directory and nothing else. Best-effort: a bind-mounted host directory
// may refuse the chmod, and that is not a reason to refuse to boot.
try { fs.chmodSync(DATA, 0o700); } catch { /* host filesystem says no — carry on */ }

/* ---------- secret ---------- */
// Still local, and still the only thing here that is: it signs session cookies and derives the
// key the Coach encrypts its provider credential with. Neither belongs in the database.
const secretFile = path.join(DATA, 'secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(secretFile, 'utf8').trim();

function atomicWrite(file, content) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/* ---------- account cache ---------- */
// Supabase is the source of truth; these are read caches so that the hot paths — every request's
// session check, and the reminder sweep that runs every 10 seconds — stay synchronous and make no
// network calls. Writes go to Postgres first and update the cache after, and a periodic reload
// picks up anything changed from another instance or straight from the dashboard.
let users = [];                              // profiles, in the shape the rest of this file expects
let subs = [];                               // push subscriptions
const CACHE_REFRESH_MS = 60000;

const toUser = r => ({
  id: r.id, name: r.name, created: r.created_at, disabled: !!r.disabled,
  admin: !!r.admin, sv: r.session_version || 0,
  lastReminder: r.last_reminder || null, invitedBy: r.invited_by || null
});
const toSub = r => ({ userId: r.user_id, endpoint: r.endpoint, keys: r.keys, created: r.created_at });

async function reloadCache() {
  const [profileRows, subRows] = await Promise.all([store.allProfiles(), store.allSubs()]);
  users = profileRows.map(toUser);
  subs = subRows.map(toSub);
}

const userById = id => users.find(u => u.id === id) || null;
const isAdmin = user => !!user && (user.admin === true || ADMIN_UIDS.includes(user.id));

/* ---------- per-user state ---------- */
// The state document lives in Postgres. A copy is mirrored to disk on every read and write purely
// so the two things that cannot await — the reminder sweep, and the Coach's synchronous
// readState() — have something local to look at. Postgres always wins; the mirror is never read
// back to answer a client request.
const stateFile = uid => path.join(DATA, 'state-' + String(uid).replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
function mirrorState(uid, state) {
  try { atomicWrite(stateFile(uid), JSON.stringify(state)); }
  catch (e) { console.error('state mirror failed', uid, e.message); }
}
function readState(uid) {
  try { return JSON.parse(fs.readFileSync(stateFile(uid), 'utf8')); } catch { return null; }
}

/* ---------- push notifications (Web Push / VAPID) ---------- */
const vapidFile = path.join(DATA, 'vapid.json');
let vapid;
try { vapid = JSON.parse(fs.readFileSync(vapidFile, 'utf8')); }
catch { vapid = webpush.generateVAPIDKeys(); fs.writeFileSync(vapidFile, JSON.stringify(vapid), { mode: 0o600 }); }
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || (SECURE ? ORIGIN : 'mailto:admin@localhost');
webpush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey);

async function sendPush(userId, payload) {
  const mine = subs.filter(s => s.userId === userId);
  if (!mine.length) return;
  const body = JSON.stringify(payload);
  const dead = [];
  await Promise.all(mine.map(async sub => {
    // urgency 'high' is the one lever we have over delivery speed — iOS/Android throttle
    // low-urgency background push more aggressively under battery-saving modes. TTL is left
    // at the library default (long) so a briefly-offline device still gets it once reconnected,
    // rather than risking it being dropped for the sake of shaving off latency that TTL doesn't
    // actually control anyway.
    try { await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, { urgency: 'high' }); }
    catch (e) {
      console.error('push send failed', userId, e.statusCode, e.body || e.message);
      if (e.statusCode === 404 || e.statusCode === 410) dead.push(sub.endpoint);
    }
  }));
  for (const endpoint of dead) {
    subs = subs.filter(s => s.endpoint !== endpoint);
    await store.deleteSub(endpoint).catch(e => console.error('prune subscription', e.message));
  }
}

// Rest-timer alerts: client schedules on start/extend, cancels on skip or on-screen completion —
// this only fires when the tab was backgrounded/suspended and never got to cancel it itself.
const restTimers = new Map(); // userId -> Timeout
function scheduleRestTimer(userId, sec) {
  const t = restTimers.get(userId);
  if (t) clearTimeout(t);
  restTimers.set(userId, setTimeout(() => {
    restTimers.delete(userId);
    sendPush(userId, { title: 'Rest over 💪', body: 'Time for your next set.', tag: 'rest-timer' });
  }, sec * 1000));
}
function cancelRestTimer(userId) {
  const t = restTimers.get(userId);
  if (t) { clearTimeout(t); restTimers.delete(userId); }
}

// "Workout planned today" reminder — one per user per day, at their chosen time.
// Duplicated (not imported) from frontend/src/lib/history.js effectiveRoutineId — tiny pure helper, not worth sharing across the two runtimes.
function effectiveRoutineId(S, iso) {
  const ov = S.dayPlan?.[iso];
  if (ov === 'rest') return null;
  if (ov && S.routines?.some(r => r.id === ov)) return ov;
  const wd = new Date(iso + 'T12:00:00').getDay();
  return S.week?.[wd] || null;
}
// Computes "now" in an arbitrary IANA zone (e.g. "Europe/Lisbon") instead of the server's own —
// each user's reminder fires by their own clock, wherever they and their phone actually are.
function userNow(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date());
    const g = t => parts.find(p => p.type === t)?.value;
    const date = `${g('year')}-${g('month')}-${g('day')}`;
    // Weekday is derived from the zone's own date, not the server's — a Sunday-evening review
    // has to be Sunday where the user is, which is what the reminder already assumes for time.
    return { date, hhmm: `${g('hour')}:${g('minute')}`, weekday: new Date(date + 'T12:00:00Z').getUTCDay() };
  } catch { return null; } // unknown/invalid tz string — skip this user rather than guess
}
setInterval(() => {
  for (const user of users) {
    if (!subs.some(s => s.userId === user.id)) continue;
    const S = readState(user.id);
    if (!S?.reminder?.on) continue;
    const now = userNow(S.reminder.tz || 'UTC');
    if (!now || S.reminder.time !== now.hhmm) continue;
    if (user.lastReminder === now.date) continue;
    if ((S.workouts || []).some(w => w.d === now.date)) continue;
    const rid = effectiveRoutineId(S, now.date);
    if (!rid) continue; // rest day — nothing planned
    const routine = (S.routines || []).find(r => r.id === rid);
    console.log('reminder firing', user.id, rid);
    // Marked in the cache first so a slow write can't let the same reminder fire twice on the
    // next tick; Postgres catches up right after, and is what survives a restart.
    user.lastReminder = now.date;
    store.updateProfile(user.id, { last_reminder: now.date })
      .catch(e => console.error('reminder bookkeeping', e.message));
    sendPush(user.id, {
      title: routine ? `${routine.emoji || '🏋️'} ${routine.name} today` : 'Workout planned today',
      body: "It's on your plan — let's go 💪",
      tag: 'day-reminder'
    });
  }
// Checked every 10s (not 60s) — ticks aren't aligned to the top of the minute, so a 60s
// interval could sit on your target minute for up to 59s before noticing. 10s caps that at ~9s.
}, 10000).unref();

/* ---------- sessions (signed cookie) ---------- */
// Supabase Auth checks the password; the cookie minted from that answer is still ours. That keeps
// session length, "sign out everywhere" and every existing route working unchanged, and means the
// browser never holds a Supabase token it could leak.
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
// Session payload is `<uid>:<expiry>:<version>`, where the version is the profile's session_version
// counter. Bumping it (POST /api/logout/all) makes every cookie ever handed out for that account
// stop verifying, which is the only revocation there is short of deleting ./data/secret and
// signing out the whole instance.
const sessionVersion = user => user.sv || 0;
function makeSession(user) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  return sign(user.id + ':' + exp + ':' + sessionVersion(user));
}
function readSession(req) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => {
    const i = c.indexOf('='); return i < 0 ? ['', ''] : [c.slice(0, i).trim(), c.slice(i + 1).trim()];
  }));
  const tok = cookies.gymsid;
  if (!tok) return null;
  const payload = verifySig(tok);
  if (!payload) return null;
  const [uid, exp, ver] = payload.split(':');
  if (!uid || +exp < Date.now()) return null;
  const user = userById(uid);
  if (!user) return null;
  if (user.disabled) return null;           // disabled accounts are locked out everywhere
  // Anything non-numeric is a malformed payload (it still had to pass the HMAC, so this is
  // belt-and-braces) and is refused outright.
  const claimed = ver === undefined ? 0 : Number(ver);
  if (!Number.isInteger(claimed) || claimed !== sessionVersion(user)) return null;
  return user;
}
// Guard for /api/admin/* — resolves the caller and 401/403s if they aren't an admin.
function requireAdmin(req, res) {
  const user = readSession(req);
  if (!user) { json(res, 401, { error: 'not signed in' }); return null; }
  if (!isAdmin(user)) { json(res, 403, { error: 'forbidden' }); return null; }
  return user;
}
function sessionCookie(user) {
  return `gymsid=${makeSession(user)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly;${SECURE} SameSite=Lax`;
}
const clearCookie = `gymsid=; Path=/; Max-Age=0; HttpOnly;${SECURE} SameSite=Lax`;

/* ---------- helpers ---------- */
function json(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(extraHeaders || {}) });
  res.end(body);
}
function readBody(req) {
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
const publicUser = user => ({ id: user.id, name: user.name, admin: isAdmin(user) });
// Deliberately loose: Supabase does the real validation, and an address this rejects but GoTrue
// would have accepted is a bug in favour of nobody.
const emailOK = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/* ---------- live presence (in-memory) ---------- */
// Clients heartbeat /api/activity while a workout is on screen; the admin dashboard reads who's
// live. Purely ephemeral — never persisted. Expires shortly after the last ping.
const presence = new Map();               // uid -> { name, exIdx, exTotal, setsDone, setsTotal, startedAt, updatedAt }
const PRESENCE_TTL = 70000;               // ~3.5× the 20s client heartbeat
function livePresence(uid) {
  const p = presence.get(uid);
  if (!p) return null;
  if (Date.now() - p.updatedAt > PRESENCE_TTL) { presence.delete(uid); return null; }
  return p;
}
setInterval(() => { for (const [k, v] of presence) if (Date.now() - v.updatedAt > PRESENCE_TTL) presence.delete(k); }, 30000).unref();

/* ---------- routes ---------- */
const routes = {
  'GET /api/health': async (req, res) => json(res, 200, { ok: true, users: users.length }),

  // Public config the login screen needs before anyone is signed in. `coach` is absent unless
  // the instance has both switched the Coach on and successfully connected a provider — the
  // single flag every piece of Coach UI hangs off, so an unconfigured instance is byte-for-byte
  // the app it was before the feature existed.
  'GET /api/config': async (req, res) => {
    const coach = coachConfig.publicConfig();
    // `features` says which optional pieces this host can actually do. Everything is available
    // here; the serverless build in frontend/api reports restTimerPush: false, and the client
    // hides what the host can't deliver instead of calling an endpoint that would fail.
    json(res, 200, {
      invite_only: INVITE_ONLY, min_password: MIN_PASSWORD,
      features: { restTimerPush: true, push: true },
      ...(coach ? { coach } : {})
    });
  },

  'GET /api/me': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    json(res, 200, { user: publicUser(user) });
  },

  /* ---------- accounts ---------- */

  'POST /api/register': async (req, res) => {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 40);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!name) return json(res, 400, { error: 'name required' });
    if (!emailOK(email)) return json(res, 400, { error: 'enter a valid email address' });
    if (password.length < MIN_PASSWORD) return json(res, 400, { error: `password must be at least ${MIN_PASSWORD} characters` });

    const code = String(body.code || '').trim().toUpperCase();
    if (INVITE_ONLY && !(await store.findOpenInvite(code)))
      return json(res, 403, { error: 'a valid invite code is required' });

    let uid;
    try { uid = await store.createAccount({ email, password, name }); }
    catch (e) { return json(res, e.status || 500, { error: e.message }); }

    // Spend the code only once the account exists, and treat losing the race for it as fatal:
    // roll the half-made account back rather than leaving an invite-only instance with a profile
    // that never presented a valid code.
    if (INVITE_ONLY && !(await store.consumeInvite(code, uid))) {
      await store.deleteAccount(uid);
      return json(res, 403, { error: 'invite code is no longer valid — ask for a new one' });
    }

    let row;
    try {
      row = await store.insertProfile({ id: uid, name, invited_by: INVITE_ONLY ? code : null });
    } catch (e) {
      // A user in auth.users with no profile can never sign in and can never be cleaned up from
      // the app, so undo it here instead.
      await store.deleteAccount(uid);
      throw e;
    }
    const user = toUser(row);
    users.push(user);
    json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user) });
  },

  'POST /api/login': async (req, res) => {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!email || !password) return json(res, 400, { error: 'email and password required' });

    const uid = await store.passwordGrant(email, password);
    // One message for "no such account" and "wrong password" alike — telling them apart tells an
    // attacker which addresses have profiles here.
    if (!uid) return json(res, 401, { error: 'wrong email or password' });

    // Signed in against Supabase but unknown here: the cache may simply be stale (registered on
    // another instance), so look again before giving up.
    let user = userById(uid);
    if (!user) { await reloadCache(); user = userById(uid); }
    if (!user) return json(res, 500, { error: 'profile missing — ask the instance admin' });
    if (user.disabled) return json(res, 403, { error: 'this account has been disabled' });
    json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user) });
  },

  // Changing a password proves the old one first: a cookie left open on a shared machine
  // shouldn't be enough to lock the owner out of their own account.
  'POST /api/password': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const current = String(body.current || '');
    const next = String(body.password || '');
    if (next.length < MIN_PASSWORD) return json(res, 400, { error: `password must be at least ${MIN_PASSWORD} characters` });
    // The address comes from Supabase Auth rather than the request, so re-checking the old
    // password can't be turned into a way of testing someone else's credentials.
    const email = await store.emailOf(user.id);
    if (!email) return json(res, 500, { error: 'account missing' });
    const uid = await store.passwordGrant(email, current);
    if (uid !== user.id) return json(res, 401, { error: 'current password is wrong' });
    await store.setPassword(user.id, next);
    json(res, 200, { ok: true });
  },

  'POST /api/logout': async (req, res) => json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie }),

  // "Sign out everywhere" — bumps this profile's session version, which invalidates every cookie
  // ever issued for the account, on every device, including a copy someone else walked off with.
  // The caller's own cookie is cleared here too, so the browser doing it doesn't sit on a token
  // it no longer accepts. The password is untouched: signing back in works immediately.
  'POST /api/logout/all': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const next = sessionVersion(user) + 1;
    await store.updateProfile(user.id, { session_version: next });
    user.sv = next;
    json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
  },

  /* ---------- state ---------- */

  'GET /api/data': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const state = await store.getState(user.id);
    if (state) mirrorState(user.id, state);
    json(res, 200, { state: state || null });
  },

  'PUT /api/data': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (!body.state || typeof body.state !== 'object') return json(res, 400, { error: 'state required' });
    delete body.state.active;              // in-progress workouts stay device-local
    await store.saveState(user.id, body.state);
    mirrorState(user.id, body.state);
    json(res, 200, { ok: true, ts: body.state._ts || null });
  },

  /* ---------- push ---------- */

  'GET /api/push/public-key': async (req, res) => json(res, 200, { key: vapid.publicKey }),

  'POST /api/push/subscribe': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const sub = body.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return json(res, 400, { error: 'invalid subscription' });
    await store.upsertSub({ endpoint: sub.endpoint, userId: user.id, keys: sub.keys });
    subs = subs.filter(s => s.endpoint !== sub.endpoint);
    subs.push({ userId: user.id, endpoint: sub.endpoint, keys: sub.keys, created: new Date().toISOString() });
    json(res, 200, { ok: true });
  },

  'POST /api/push/unsubscribe': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const endpoint = String(body.endpoint || '');
    // Scoped to the caller's own subscriptions so one profile can't unsubscribe another's device.
    if (!subs.some(s => s.userId === user.id && s.endpoint === endpoint)) return json(res, 200, { ok: true });
    await store.deleteSub(endpoint);
    subs = subs.filter(s => s.endpoint !== endpoint);
    json(res, 200, { ok: true });
  },

  'POST /api/push/test': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    await sendPush(user.id, { title: 'openGym', body: 'Test notification ✅ — this is what alerts look like.', tag: 'test' });
    json(res, 200, { ok: true });
  },

  'POST /api/push/rest-timer': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const sec = Math.max(1, Math.min(3600, Math.round(+body.seconds || 0)));
    if (!sec) return json(res, 400, { error: 'seconds required' });
    scheduleRestTimer(user.id, sec);
    json(res, 200, { ok: true });
  },

  'POST /api/push/rest-timer/cancel': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    cancelRestTimer(user.id);
    json(res, 200, { ok: true });
  },

  // Live-workout heartbeat: client pings while a workout is on screen; { active:false } drops it.
  'POST /api/activity': async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (body.active) {
      presence.set(user.id, {
        name: String(body.name || '').slice(0, 60),
        exIdx: +body.exIdx || 0, exTotal: +body.exTotal || 0,
        setsDone: +body.setsDone || 0, setsTotal: +body.setsTotal || 0,
        startedAt: +body.startedAt || Date.now(),
        updatedAt: Date.now()
      });
    } else presence.delete(user.id);
    json(res, 200, { ok: true });
  },

  /* ---------- admin dashboard ---------- */
  // One row per user. Emails come from Supabase Auth rather than being copied into `profiles`,
  // so there is exactly one record of an address and it is the one Supabase signs people in with.
  'GET /api/admin/users': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const emails = new Map();
    try {
      const { data } = await store.sb.auth.admin.listUsers({ perPage: 1000 });
      for (const u of data?.users || []) emails.set(u.id, u.email || null);
    } catch (e) { console.error('list auth users', e.message); }
    const stateRows = new Map((await store.allState()).map(r => [r.user_id, r.state || {}]));
    const list = users.map(u => {
      const S = stateRows.get(u.id) || {};
      const workouts = S.workouts || [];
      const last = workouts[workouts.length - 1];
      return {
        id: u.id, name: u.name, email: emails.get(u.id) || null, created: u.created || null,
        disabled: !!u.disabled, admin: isAdmin(u), invitedBy: u.invitedBy || null,
        workouts: workouts.length,
        lastWorkout: last ? last.d : null,
        lastSync: S._ts || null,
        hasPush: subs.some(s => s.userId === u.id),
        live: livePresence(u.id)
      };
    });
    json(res, 200, { users: list, invite_only: INVITE_ONLY, now: Date.now() });
  },

  // Drill-down: full workout history + body-weight log for one user.
  'GET /api/admin/user': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const u = userById(id);
    if (!u) return json(res, 404, { error: 'no such user' });
    const S = (await store.getState(u.id)) || {};
    json(res, 200, {
      user: { id: u.id, name: u.name, created: u.created || null, disabled: !!u.disabled, admin: isAdmin(u), invitedBy: u.invitedBy || null },
      unit: S.unit || 'kg',
      lastSync: S._ts || null,
      routines: (S.routines || []).map(r => ({ id: r.id, name: r.name, emoji: r.emoji, count: (r.ex || []).length })),
      bodyweight: S.bodyweight || [],
      workouts: (S.workouts || []).slice().reverse()   // newest first for display
    });
  },

  'POST /api/admin/user/disable': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const u = userById(body.id);
    if (!u) return json(res, 404, { error: 'no such user' });
    if (isAdmin(u)) return json(res, 400, { error: 'cannot disable an admin' });
    const disabled = !!body.disabled;
    await store.updateProfile(u.id, { disabled });
    u.disabled = disabled;
    if (disabled) presence.delete(u.id);   // drop them off "training now" at once
    json(res, 200, { ok: true, id: u.id, disabled });
  },

  'GET /api/admin/invites': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const rows = await store.allInvites();
    // resolve used_by uid → name for display
    const invites = rows.map(i => ({
      code: i.code, note: i.note, created: i.created_at, createdBy: i.created_by,
      usedBy: i.used_by, usedAt: i.used_at,
      usedByName: i.used_by ? (userById(i.used_by) || {}).name || null : null
    }));
    json(res, 200, { invites, invite_only: INVITE_ONLY });
  },

  'POST /api/admin/invites/new': async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    // 16 hex chars = 64 bits. The app has no rate limiting by design (that's the reverse proxy's
    // job) and /api/register tells a caller whether a code is good, so the code itself has to be
    // the thing that isn't worth guessing.
    const code = crypto.randomBytes(8).toString('hex').toUpperCase();
    const row = await store.insertInvite({ code, note: String(body.note || '').slice(0, 60), created_by: admin.id });
    json(res, 200, { invite: { code: row.code, note: row.note, created: row.created_at, createdBy: row.created_by } });
  },

  'POST /api/admin/invites/revoke': async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const code = String(body.code || '').toUpperCase();
    const rows = await store.allInvites();
    const inv = rows.find(i => i.code === code);
    if (!inv) return json(res, 404, { error: 'no such code' });
    if (inv.used_by) return json(res, 400, { error: 'already used — cannot revoke' });
    await store.deleteInvite(code);
    json(res, 200, { ok: true });
  },

  /* ---------- AI Coach ---------- */
  // Routes live in coach/routes.js and are handed the helpers above rather than importing
  // them: they are closures over the session secret and the account cache, and passing them in
  // keeps that module free of a cycle. Every one of them is inert while the feature is
  // unconfigured.
  ...coachRoutes({ json, readBody, readSession, requireAdmin })
};

/* ---------- boot ---------- */
async function main() {
  await reloadCache();
  // The Coach and the reminder sweep read state synchronously off the mirror, so a container that
  // just came up with an empty ./data has to be given one before either runs.
  for (const row of await store.allState()) mirrorState(row.user_id, row.state || {});
  console.log(`loaded ${users.length} profile(s) from Supabase`);

  setInterval(() => {
    reloadCache().catch(e => console.error('cache refresh failed', e.message));
  }, CACHE_REFRESH_MS).unref();

  /* Coach: boot recovery, notifications, scheduled reviews */
  // A job that was running when the process died is not coming back; say so rather than leaving
  // a spinner that never resolves.
  coachJobs.recoverOnBoot();
  // A ready proposal is the one Coach event worth a notification. Failures and "nothing to
  // change" stay silent on purpose (FR-38/E4).
  coachJobs.setProposalHook((uid, pending) => {
    const n = (pending?.changes || []).length;
    if (!n) return;
    sendPush(uid, {
      title: 'Your Coach has been reading',
      body: n === 1 ? '1 suggestion after this week' : `${n} suggestions after this week`,
      tag: 'coach-proposal', url: '#/coach'
    });
  });
  startCadence({ users: () => users, userNow });

  http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const key = req.method + ' ' + url.pathname;
    const handler = routes[key];
    if (!handler) return json(res, 404, { error: 'not found' });
    try { await handler(req, res); }
    catch (e) {
      console.error(key, e);
      if (!res.headersSent) json(res, 500, { error: 'server error' });
    }
  }).listen(PORT, () => console.log(`gym-api on :${PORT} (origin=${ORIGIN}, supabase)`));
}

main().catch(e => {
  // Almost always a bad SUPABASE_URL/key or an unmigrated project — a loud stop beats a server
  // that answers every request with a 500.
  console.error('failed to start:', e.message);
  process.exit(1);
});
