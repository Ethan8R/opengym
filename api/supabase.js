/* Supabase access for the openGym API.
 *
 * Everything that used to live in ./data/db.json — accounts, per-profile state, push
 * subscriptions, invite codes — is now rows in Postgres, and the email/password half of an
 * account is Supabase Auth's `auth.users`. This module is the only place that knows that.
 *
 * It runs with the project's *secret* key, which bypasses RLS. That key never leaves the server:
 * the browser talks to this API over the same origin it always did and holds no Supabase
 * credential of any kind. See supabase/migrations/*_opengym_backend.sql — the tables grant nothing
 * to `anon`/`authenticated`, so the API really is the only way in.
 */
import { createClient } from '@supabase/supabase-js';

const URL_ = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
// SUPABASE_SECRET_KEY is the current name (`sb_secret_…`); the older projects call the same thing
// a service-role key, so accept either rather than making people rename an env var.
const KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

export const configured = !!(URL_ && KEY);

if (!configured) {
  console.error(
    '\n  openGym needs a Supabase project.\n' +
    '  Set SUPABASE_URL and SUPABASE_SECRET_KEY in your .env — see docs/SUPABASE.md.\n'
  );
  process.exit(1);
}

/* This client is used for database access and for the Auth *admin* endpoints only. It is
   deliberately never used to sign a user in: supabase-js attaches a signed-in user's token to
   subsequent requests from the same client, which would quietly drop it from service_role down to
   that user. Password sign-in goes through passwordGrant() below instead, which is a bare fetch
   and leaves no state behind. */
export const sb = createClient(URL_, KEY, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
});

/** Unwrap a PostgREST/GoTrue result, turning `{ error }` into a thrown Error. */
function ok({ data, error }, what) {
  if (error) {
    const e = new Error(`${what}: ${error.message}`);
    e.cause = error;
    throw e;
  }
  return data;
}

/* ---------- auth (Supabase Auth owns emails and password hashes) ---------- */

/**
 * Create a confirmed account. `email_confirm: true` is what makes a self-hosted instance work at
 * all: hosted Supabase requires email confirmation by default, and its built-in mailer only sends
 * a couple of messages an hour to project members, so waiting on a confirmation link would lock
 * out every account on a personal instance. Point Supabase at real SMTP and drop this flag if you
 * want addresses verified for real.
 * Returns the new user's id.
 */
export async function createAccount({ email, password, name }) {
  const { data, error } = await sb.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { name }
  });
  if (error) {
    // GoTrue reports an address that is already taken as a 422; say so in the app's own words
    // rather than leaking the provider's phrasing.
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

/**
 * Check an email/password pair. Returns the user id, or null when the credentials are wrong.
 * A bare fetch rather than supabase-js on purpose (see the note on `sb` above). Any 2xx is a
 * success — the token endpoint's exact status code is not something to hard-code.
 */
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

/** The address Supabase signs this profile in with. `profiles` deliberately does not copy it. */
export async function emailOf(uid) {
  const { data, error } = await sb.auth.admin.getUserById(uid);
  if (error) throw new Error('look up account: ' + error.message);
  return data?.user?.email || null;
}

export async function setPassword(uid, password) {
  ok(await sb.auth.admin.updateUserById(uid, { password }), 'change password');
}

/** Used when a half-created account has to be rolled back — see the sign-up route. */
export async function deleteAccount(uid) {
  await sb.auth.admin.deleteUser(uid).catch(() => { /* best effort */ });
}

/* ---------- profiles ---------- */

export async function allProfiles() {
  return ok(await sb.from('profiles').select('*').order('created_at'), 'load profiles') || [];
}

export async function insertProfile(row) {
  return ok(await sb.from('profiles').insert(row).select().single(), 'create profile');
}

export async function updateProfile(id, patch) {
  return ok(await sb.from('profiles').update(patch).eq('id', id).select().single(), 'update profile');
}

/* ---------- per-profile state ---------- */

export async function allState() {
  return ok(await sb.from('user_state').select('user_id, state'), 'load state') || [];
}

export async function getState(uid) {
  const { data, error } = await sb.from('user_state').select('state').eq('user_id', uid).maybeSingle();
  if (error) throw new Error('load state: ' + error.message);
  return data?.state ?? null;
}

export async function saveState(uid, state) {
  ok(await sb.from('user_state')
    .upsert({ user_id: uid, state, updated_at: new Date().toISOString() }, { onConflict: 'user_id' }),
  'save state');
}

/* ---------- push subscriptions ---------- */

export async function allSubs() {
  return ok(await sb.from('push_subscriptions').select('*'), 'load push subscriptions') || [];
}

/** Endpoint is the primary key, so re-subscribing the same browser replaces the old row. */
export async function upsertSub({ endpoint, userId, keys }) {
  ok(await sb.from('push_subscriptions')
    .upsert({ endpoint, user_id: userId, keys, created_at: new Date().toISOString() }, { onConflict: 'endpoint' }),
  'save push subscription');
}

export async function deleteSub(endpoint) {
  ok(await sb.from('push_subscriptions').delete().eq('endpoint', endpoint), 'remove push subscription');
}

/* ---------- invite codes ---------- */

export async function allInvites() {
  return ok(await sb.from('invites').select('*').order('created_at'), 'load invites') || [];
}

export async function findOpenInvite(code) {
  const { data, error } = await sb.from('invites')
    .select('*').eq('code', code).is('used_by', null).maybeSingle();
  if (error) throw new Error('check invite: ' + error.message);
  return data || null;
}

export async function insertInvite(row) {
  return ok(await sb.from('invites').insert(row).select().single(), 'create invite');
}

/**
 * Spend a code, but only if it is still unspent — the `is('used_by', null)` filter makes this a
 * compare-and-set, so two people racing the same code cannot both get in. Returns false if it was
 * already taken.
 */
export async function consumeInvite(code, uid) {
  const data = ok(await sb.from('invites')
    .update({ used_by: uid, used_at: new Date().toISOString() })
    .eq('code', code).is('used_by', null).select(), 'use invite');
  return (data || []).length > 0;
}

export async function deleteInvite(code) {
  ok(await sb.from('invites').delete().eq('code', code), 'revoke invite');
}
