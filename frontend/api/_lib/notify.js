/* Web Push for the Vercel deployment.
 *
 * The container build generates a VAPID keypair on first run and keeps it in ./data. There is no
 * disk here, and a freshly generated pair on every invocation would invalidate every subscription
 * a browser has ever made, so the keys are supplied as environment variables instead. Generate a
 * pair once with `npx web-push generate-vapid-keys` and set them for good — see docs/VERCEL.md.
 */
import webpush from 'web-push';
import * as store from './store.js';

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
// web-push refuses any subject that isn't an https: or mailto: URL, and throws when it sees one.
// ORIGIN is only usable when it is https, which it always is on Vercel but is not when this is
// pointed at a local test server — so fall back rather than let a valid config choice explode.
const RAW_SUBJECT = process.env.VAPID_SUBJECT || '';
const ORIGIN = process.env.ORIGIN || '';
const SUBJECT = /^(https:|mailto:)/i.test(RAW_SUBJECT) ? RAW_SUBJECT
  : /^https:/i.test(ORIGIN) ? ORIGIN
  : 'mailto:admin@localhost';

export const pushConfigured = () => !!(PUBLIC_KEY && PRIVATE_KEY);
export const publicKey = () => PUBLIC_KEY;

let ready = false;
function init() {
  if (ready) return true;
  if (!pushConfigured()) return false;
  // A bad key or subject must not take down the caller: the reminder sweep sends to everyone in
  // one request, and one misconfigured value shouldn't turn that into a 500.
  try { webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY); ready = true; }
  catch (e) { console.error('VAPID configuration is invalid:', e.message); return false; }
  return true;
}

/** Send to every device a profile has registered, pruning the ones the push service has retired. */
export async function sendPush(userId, payload) {
  if (!init()) return;
  const subs = await store.subsFor(userId);
  if (!subs.length) return;
  const body = JSON.stringify(payload);
  const dead = [];
  await Promise.all(subs.map(async sub => {
    try { await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, { urgency: 'high' }); }
    catch (e) {
      console.error('push send failed', userId, e.statusCode, e.body || e.message);
      if (e.statusCode === 404 || e.statusCode === 410) dead.push(sub.endpoint);
    }
  }));
  for (const endpoint of dead) {
    await store.deleteSub(endpoint).catch(e => console.error('prune subscription', e.message));
  }
}
