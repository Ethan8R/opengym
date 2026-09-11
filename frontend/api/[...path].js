/* Every /api/* route, in one Vercel function.
 *
 * A catch-all rather than one file per endpoint, for two reasons: the route table stays a single
 * readable list that lines up with api/server.js, and the whole API is one cold start instead of
 * twenty. Files under _lib/ are shared helpers; Vercel ignores anything starting with `_`.
 *
 * What is NOT here, and cannot be:
 *   · the AI Coach — it spawns a provider CLI and runs for minutes; serverless does neither.
 *     /api/config simply never reports a coach, so no Coach UI appears anywhere in the app.
 *   · server-scheduled rest-timer alerts — they need a process still alive 90 seconds after the
 *     request. The endpoints answer honestly (see below) and /api/config says the feature is off.
 * The container build in api/ still has both. See docs/VERCEL.md.
 */
import crypto from 'node:crypto';
import * as store from './_lib/store.js';
import * as notify from './_lib/notify.js';
import { effectiveRoutineId, userNow } from './_lib/plan.js';
import {
  json, readBody, readSession, requireAdmin, sessionCookie, clearCookie,
  isAdmin, publicUser, emailOK, secretMissing,
  INVITE_ONLY, MIN_PASSWORD
} from './_lib/session.js';

const PRESENCE_TTL = 70000;   // ~3.5x the 20s client heartbeat

const routes = {
  'GET /api/health': async (req, res) => {
    const users = await store.allProfiles();
    json(res, 200, { ok: true, users: users.length });
  },

  // Public config the login screen reads before anyone is signed in. `coach` is absent on this
  // deployment by construction. `features` tells the client which optional pieces exist here, so
  // it can hide what this host cannot do rather than calling an endpoint that quietly no-ops.
  'GET /api/config': async (req, res) => json(res, 200, {
    invite_only: INVITE_ONLY,
    min_password: MIN_PASSWORD,
    features: { restTimerPush: false, push: notify.pushConfigured() }
  }),

  'GET /api/me': async (req, res) => {
    const user = await readSession(req);
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

    // Spend the code only once the account exists, and treat losing the race as fatal: roll the
    // half-made account back rather than leaving an invite-only instance with a profile that
    // never presented a valid code.
    if (INVITE_ONLY && !(await store.consumeInvite(code, uid))) {
      await store.deleteAccount(uid);
      return json(res, 403, { error: 'invite code is no longer valid — ask for a new one' });
    }

    let user;
    try {
      user = await store.insertProfile({ id: uid, name, invited_by: INVITE_ONLY ? code : null });
    } catch (e) {
      // A user in auth.users with no profile can never sign in and can never be cleaned up from
      // the app, so undo it here instead.
      await store.deleteAccount(uid);
      throw e;
    }
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

    // An account created in the Supabase dashboard has no profile yet; give it one rather than
    // leaving somebody with working credentials and no way in.
    const user = (await store.profile(uid)) || (await store.adoptAccount(uid));
    if (!user) return json(res, 500, { error: 'profile missing — ask the instance admin' });
    if (user.disabled) return json(res, 403, { error: 'this account has been disabled' });
    json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user) });
  },

  // Changing a password proves the old one first: a cookie left open on a shared machine
  // shouldn't be enough to lock the owner out of their own account.
  'POST /api/password': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const current = String(body.current || '');
    const next = String(body.password || '');
    if (next.length < MIN_PASSWORD) return json(res, 400, { error: `password must be at least ${MIN_PASSWORD} characters` });
    // The address comes from Supabase rather than the request, so re-checking the old password
    // can't be turned into a way of testing someone else's credentials.
    const email = await store.emailOf(user.id);
    if (!email) return json(res, 500, { error: 'account missing' });
    if ((await store.passwordGrant(email, current)) !== user.id) return json(res, 401, { error: 'current password is wrong' });
    await store.setPassword(user.id, next);
    json(res, 200, { ok: true });
  },

  'POST /api/logout': async (req, res) => json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie }),

  // "Sign out everywhere" — bumps this profile's session version, which invalidates every cookie
  // ever issued for the account, on every device, including a copy someone walked off with.
  'POST /api/logout/all': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    await store.updateProfile(user.id, { session_version: (user.sv || 0) + 1 });
    json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
  },

  /* ---------- state ---------- */

  'GET /api/data': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    json(res, 200, { state: (await store.getState(user.id)) || null });
  },

  'PUT /api/data': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (!body.state || typeof body.state !== 'object') return json(res, 400, { error: 'state required' });
    delete body.state.active;              // in-progress workouts stay device-local
    await store.saveState(user.id, body.state);
    json(res, 200, { ok: true, ts: body.state._ts || null });
  },

  /* ---------- push ---------- */

  'GET /api/push/public-key': async (req, res) => {
    if (!notify.pushConfigured()) return json(res, 503, { error: 'push is not configured on this deployment' });
    json(res, 200, { key: notify.publicKey() });
  },

  'POST /api/push/subscribe': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const sub = body.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return json(res, 400, { error: 'invalid subscription' });
    await store.upsertSub({ endpoint: sub.endpoint, userId: user.id, keys: sub.keys });
    json(res, 200, { ok: true });
  },

  'POST /api/push/unsubscribe': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    const endpoint = String(body.endpoint || '');
    // Scoped to the caller's own subscriptions so one profile can't unsubscribe another's device.
    const mine = await store.subsFor(user.id);
    if (!mine.some(s => s.endpoint === endpoint)) return json(res, 200, { ok: true });
    await store.deleteSub(endpoint);
    json(res, 200, { ok: true });
  },

  'POST /api/push/test': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    if (!notify.pushConfigured()) return json(res, 503, { error: 'push is not configured on this deployment' });
    await notify.sendPush(user.id, { title: 'openGym', body: 'Test notification ✅ — this is what alerts look like.', tag: 'test' });
    json(res, 200, { ok: true });
  },

  // Answering 501 rather than a cheerful { ok: true }: a rest alert scheduled here would need a
  // process still running 90 seconds later, and there isn't one. The client checks
  // /api/config features.restTimerPush and doesn't call these; this is the backstop for an old
  // tab that hasn't reloaded.
  'POST /api/push/rest-timer': async (req, res) =>
    json(res, 501, { error: 'background rest-timer alerts need the container build' }),
  'POST /api/push/rest-timer/cancel': async (req, res) => json(res, 200, { ok: true }),

  // Live-workout heartbeat: client pings while a workout is on screen; { active:false } drops it.
  'POST /api/activity': async (req, res) => {
    const user = await readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    const body = await readBody(req);
    if (body.active) {
      await store.setPresence(user.id, {
        name: String(body.name || '').slice(0, 60),
        ex_idx: +body.exIdx || 0, ex_total: +body.exTotal || 0,
        sets_done: +body.setsDone || 0, sets_total: +body.setsTotal || 0,
        started_at: +body.startedAt || Date.now()
      });
    } else await store.clearPresence(user.id);
    json(res, 200, { ok: true });
  },

  /* ---------- admin dashboard ---------- */

  'GET /api/admin/users': async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const [users, stateRows, subs, live] = await Promise.all([
      store.allProfiles(), store.allState(), store.allSubs(), store.livePresence(PRESENCE_TTL)
    ]);
    const emails = new Map();
    try {
      const { data } = await store.sb().auth.admin.listUsers({ perPage: 1000 });
      for (const u of data?.users || []) emails.set(u.id, u.email || null);
    } catch (e) { console.error('list auth users', e.message); }
    const byUid = new Map(stateRows.map(r => [r.user_id, r.state || {}]));
    const list = users.map(u => {
      const S = byUid.get(u.id) || {};
      const workouts = S.workouts || [];
      const last = workouts[workouts.length - 1];
      return {
        id: u.id, name: u.name, email: emails.get(u.id) || null, created: u.created || null,
        disabled: !!u.disabled, admin: isAdmin(u), invitedBy: u.invitedBy || null,
        workouts: workouts.length,
        lastWorkout: last ? last.d : null,
        lastSync: S._ts || null,
        hasPush: subs.some(s => s.userId === u.id),
        live: live.get(u.id) || null
      };
    });
    json(res, 200, { users: list, invite_only: INVITE_ONLY, now: Date.now() });
  },

  'GET /api/admin/user': async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    const u = id ? await store.profile(id) : null;
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
    if (!(await requireAdmin(req, res))) return;
    const body = await readBody(req);
    const u = body.id ? await store.profile(body.id) : null;
    if (!u) return json(res, 404, { error: 'no such user' });
    if (isAdmin(u)) return json(res, 400, { error: 'cannot disable an admin' });
    const disabled = !!body.disabled;
    await store.updateProfile(u.id, { disabled });
    if (disabled) await store.clearPresence(u.id).catch(() => {});   // drop them off "training now" at once
    json(res, 200, { ok: true, id: u.id, disabled });
  },

  'GET /api/admin/invites': async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const [rows, users] = await Promise.all([store.allInvites(), store.allProfiles()]);
    const nameOf = uid => (users.find(u => u.id === uid) || {}).name || null;
    json(res, 200, {
      invites: rows.map(i => ({
        code: i.code, note: i.note, created: i.created_at, createdBy: i.created_by,
        usedBy: i.used_by, usedAt: i.used_at, usedByName: i.used_by ? nameOf(i.used_by) : null
      })),
      invite_only: INVITE_ONLY
    });
  },

  'POST /api/admin/invites/new': async (req, res) => {
    const admin = await requireAdmin(req, res); if (!admin) return;
    const body = await readBody(req);
    // 16 hex chars = 64 bits. There is no rate limiting here by design, and /api/register tells a
    // caller whether a code is good, so the code itself has to be the thing not worth guessing.
    const code = crypto.randomBytes(8).toString('hex').toUpperCase();
    const row = await store.insertInvite({ code, note: String(body.note || '').slice(0, 60), created_by: admin.id });
    json(res, 200, { invite: { code: row.code, note: row.note, created: row.created_at, createdBy: row.created_by } });
  },

  'POST /api/admin/invites/revoke': async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const body = await readBody(req);
    const code = String(body.code || '').toUpperCase();
    const inv = (await store.allInvites()).find(i => i.code === code);
    if (!inv) return json(res, 404, { error: 'no such code' });
    if (inv.used_by) return json(res, 400, { error: 'already used — cannot revoke' });
    await store.deleteInvite(code);
    json(res, 200, { ok: true });
  },

  /* ---------- scheduled: workout-day reminders ---------- */
  // The container build sweeps every 10 seconds and fires at each user's chosen minute. Here the
  // sweep is a cron job, and how close it gets depends on the plan: Vercel's free tier runs cron
  // once a day, Pro runs it once a minute. See the note on `coarse` below and docs/VERCEL.md.
  'GET /api/cron/reminders': runReminders,
  'POST /api/cron/reminders': runReminders
};

async function runReminders(req, res) {
  // Vercel sends `Authorization: Bearer $CRON_SECRET` when that variable is set. Requiring it
  // stops anyone on the internet from triggering everyone's notifications.
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) return json(res, 401, { error: 'unauthorized' });
  if (!notify.pushConfigured()) return json(res, 200, { ok: true, skipped: 'push not configured' });

  // A schedule whose minute field isn't `*` cannot land on anybody's chosen minute, so on those
  // (every free-tier schedule) the time-of-day check is dropped and the reminder goes out whenever
  // the job happens to run. On a per-minute schedule it is punctual, exactly like the container.
  const schedule = req.headers['x-vercel-cron-schedule'] || '';
  const coarse = !schedule || !schedule.trim().startsWith('*');

  const [users, stateRows, subs] = await Promise.all([store.allProfiles(), store.allState(), store.allSubs()]);
  const byUid = new Map(stateRows.map(r => [r.user_id, r.state || {}]));
  let sent = 0;

  for (const user of users) {
    if (user.disabled) continue;
    if (!subs.some(s => s.userId === user.id)) continue;
    const S = byUid.get(user.id);
    if (!S?.reminder?.on) continue;
    const now = userNow(S.reminder.tz || 'UTC');
    if (!now) continue;
    if (!coarse && S.reminder.time !== now.hhmm) continue;
    if (coarse && S.reminder.time > now.hhmm) continue;   // their time hasn't come round yet today
    if (user.lastReminder === now.date) continue;
    if ((S.workouts || []).some(w => w.d === now.date)) continue;
    const rid = effectiveRoutineId(S, now.date);
    if (!rid) continue;                                   // rest day — nothing planned
    const routine = (S.routines || []).find(r => r.id === rid);
    // Marked first so a slow send can't double-fire on an overlapping run.
    await store.updateProfile(user.id, { last_reminder: now.date });
    await notify.sendPush(user.id, {
      title: routine ? `${routine.emoji || '🏋️'} ${routine.name} today` : 'Workout planned today',
      body: "It's on your plan — let's go 💪",
      tag: 'day-reminder'
    });
    sent++;
  }
  json(res, 200, { ok: true, checked: users.length, sent, coarse });
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  // Nested paths (/api/push/subscribe, /api/admin/users, …) arrive via the rewrite in
  // vercel.json, which rewrites req.url to this function's own path and puts the original in
  // __p. Single-segment paths match the function directly and still have their real pathname.
  const rewritten = url.searchParams.get('__p');
  const pathname = (rewritten ? '/api/' + rewritten : url.pathname).replace(/\/+$/, '');
  const key = req.method + ' ' + pathname;

  // Misconfiguration is the likeliest failure on a fresh deployment, and there is no boot log on
  // Vercel for anyone to read, so say it in the response instead of failing obscurely.
  if (!store.configured) return json(res, 500, { error: 'SUPABASE_URL and SUPABASE_SECRET_KEY are not set on this deployment' });
  if (secretMissing()) return json(res, 500, { error: 'SESSION_SECRET is not set on this deployment (needs 32+ characters)' });

  const handle = routes[key];
  if (!handle) return json(res, 404, { error: 'not found' });
  try { await handle(req, res); }
  catch (e) {
    console.error(key, e);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
  }
}
