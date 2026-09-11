/* Supabase access for the Vercel deployment.
 *
 * Mirrors api/supabase.js (the container build) with one deliberate difference: nothing is
 * cached. A serverless function starts, answers one request and stops, so every lookup —
 * including the session's profile check — is a live query. That costs a round trip per request
 * and buys correctness: there is no stale in-memory copy to go wrong.
 *
 * Files starting with `_` are not routes, so this is a plain module, not an endpoint.
 */
import { createClient } from '@supabase/supabase-js';

const URL_ = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

export const configured = !!(URL_ && KEY);

/* Built lazily so an unconfigured deployment answers with a readable error instead of crashing
   the whole function at import time — on Vercel there is no startup log for anyone to read. */
let client = null;
export function sb() {
  if (!configured) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are not set on this deployment');
  if (!client) {
    client = createClient(URL_, KEY, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
    });
  }
  return client;
}

function ok({ data, error }, what) {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}

/* ---------- auth ---------- */

export async function createAccount({ email, password, name }) {
  const { data, error } = await sb().auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { name }
  });
  if (error) {
    if (error.status === 422 || /already/i.test(error.message)) {
      const e = new Error('that email already has a profile — sign in instead');
      e.status = 409;
      throw e;
    }
    const e = new Error(error.message);
    e.status = error.status || 500;
    throw e;
  }
  return data.user.id;
}

/** Check a password. Returns the user id or null. A bare fetch, so no client state is touched. */
export async function passwordGrant(email, password) {
  const res = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ email, password })
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  return body?.user?.id || null;
}

export async function emailOf(uid) {
  const { data, error } = await sb().auth.admin.getUserById(uid);
  if (error) throw new Error('look up account: ' + error.message);
  return data?.user?.email || null;
}

export async function setPassword(uid, password) {
  ok(await sb().auth.admin.updateUserById(uid, { password }), 'change password');
}

export async function deleteAccount(uid) {
  await sb().auth.admin.deleteUser(uid).catch(() => { /* best effort rollback */ });
}

/* ---------- profiles ---------- */

export const toUser = r => r && ({
  id: r.id, name: r.name, created: r.created_at, disabled: !!r.disabled,
  admin: !!r.admin, sv: r.session_version || 0,
  lastReminder: r.last_reminder || null, invitedBy: r.invited_by || null
});

export async function profile(id) {
  const { data, error } = await sb().from('profiles').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error('load profile: ' + error.message);
  return toUser(data);
}

export async function allProfiles() {
  return (ok(await sb().from('profiles').select('*').order('created_at'), 'load profiles') || []).map(toUser);
}

export async function insertProfile(row) {
  return toUser(ok(await sb().from('profiles').insert(row).select().single(), 'create profile'));
}

export async function updateProfile(id, patch) {
  ok(await sb().from('profiles').update(patch).eq('id', id).select().single(), 'update profile');
}

/* ---------- per-profile state ---------- */

export async function getState(uid) {
  const { data, error } = await sb().from('user_state').select('state').eq('user_id', uid).maybeSingle();
  if (error) throw new Error('load state: ' + error.message);
  return data?.state ?? null;
}

export async function allState() {
  return ok(await sb().from('user_state').select('user_id, state'), 'load state') || [];
}

export async function saveState(uid, state) {
  ok(await sb().from('user_state')
    .upsert({ user_id: uid, state, updated_at: new Date().toISOString() }, { onConflict: 'user_id' }),
  'save state');
}

/* ---------- push subscriptions ---------- */

const toSub = r => ({ userId: r.user_id, endpoint: r.endpoint, keys: r.keys });

export async function subsFor(uid) {
  return (ok(await sb().from('push_subscriptions').select('*').eq('user_id', uid), 'load subscriptions') || []).map(toSub);
}

export async function allSubs() {
  return (ok(await sb().from('push_subscriptions').select('*'), 'load subscriptions') || []).map(toSub);
}

export async function upsertSub({ endpoint, userId, keys }) {
  ok(await sb().from('push_subscriptions')
    .upsert({ endpoint, user_id: userId, keys, created_at: new Date().toISOString() }, { onConflict: 'endpoint' }),
  'save subscription');
}

export async function deleteSub(endpoint) {
  ok(await sb().from('push_subscriptions').delete().eq('endpoint', endpoint), 'remove subscription');
}

/* ---------- live presence ---------- */
// In the container build this is a Map in memory. Serverless has no memory between requests, so
// it is a table with a heartbeat timestamp and the readers filter on recency.

export async function setPresence(uid, data) {
  ok(await sb().from('presence')
    .upsert({ user_id: uid, ...data, updated_at: new Date().toISOString() }, { onConflict: 'user_id' }),
  'save presence');
}

export async function clearPresence(uid) {
  ok(await sb().from('presence').delete().eq('user_id', uid), 'clear presence');
}

/** Rows seen within PRESENCE_TTL, keyed by uid. Stale rows are dropped as they are read. */
export async function livePresence(ttlMs = 70000) {
  const since = new Date(Date.now() - ttlMs).toISOString();
  const rows = ok(await sb().from('presence').select('*').gte('updated_at', since), 'load presence') || [];
  return new Map(rows.map(r => [r.user_id, {
    name: r.name, exIdx: r.ex_idx, exTotal: r.ex_total,
    setsDone: r.sets_done, setsTotal: r.sets_total,
    startedAt: r.started_at, updatedAt: new Date(r.updated_at).getTime()
  }]));
}

/* ---------- invite codes ---------- */

export async function allInvites() {
  return ok(await sb().from('invites').select('*').order('created_at'), 'load invites') || [];
}

export async function findOpenInvite(code) {
  const { data, error } = await sb().from('invites')
    .select('*').eq('code', code).is('used_by', null).maybeSingle();
  if (error) throw new Error('check invite: ' + error.message);
  return data || null;
}

export async function insertInvite(row) {
  return ok(await sb().from('invites').insert(row).select().single(), 'create invite');
}

/** Compare-and-set, so two people racing the same code cannot both get in. */
export async function consumeInvite(code, uid) {
  const data = ok(await sb().from('invites')
    .update({ used_by: uid, used_at: new Date().toISOString() })
    .eq('code', code).is('used_by', null).select(), 'use invite');
  return (data || []).length > 0;
}

export async function deleteInvite(code) {
  ok(await sb().from('invites').delete().eq('code', code), 'revoke invite');
}
