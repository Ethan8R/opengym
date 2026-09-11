# Security policy

openGym is a self-hosted app: you run the server, you hold the data. This file says which
versions get fixes, how to report something privately, and — the part most people actually
need — what the app protects you from and what it doesn't.

## Supported versions

Only the **latest release**. Releases are semver tags (`v1.0.0` → `v1.2.3`, see
[CHANGELOG.md](CHANGELOG.md)); there is no LTS or maintenance branch and older tags are never
patched. A fix ships in the next release and in the `latest` images on ghcr.io.

Updating a self-hosted instance:

```bash
git pull && docker compose pull && docker compose up -d
```

## Reporting a vulnerability

Use GitHub's private vulnerability reporting — repo **Security** tab → **Report a vulnerability**:

<https://github.com/DuarteSantos8/openGym/security/advisories/new>

> Private reporting has to be switched on in the repository settings for that link to work
> (Settings → Advanced Security → Private vulnerability reporting). If it 404s, open a normal
> issue saying only *"I need a private channel for a security report"* — no details, no repro —
> and it will be enabled.

Please don't put a working exploit in a public issue if it can be used against other people's
instances. Everything else (a crash you can only trigger on your own box, a scanner warning)
is fine as a normal issue.

Useful in a report: the version or commit, whether you're running the prebuilt images or a
source build, your `ORIGIN` and what sits in front of the app, steps to reproduce, and what an
attacker gets out of it. Never include your `SUPABASE_SECRET_KEY` in a report.

**On response times:** this is a hobby project maintained by one person alongside school. There
is no SLA and no bounty. Expect days rather than hours, and longer during exam periods. If a
week goes by with no reply, comment on the advisory thread — it's more likely to be a missed
notification than a decision. If a report goes unfixed and you want to disclose publicly, say so
in the thread; there's no objection, and no request to sit on it indefinitely.

## In scope

- **`api/server.js` and `api/supabase.js`** — forging or replaying a session cookie, signing in
  without the right password, reading or writing another user's data through `/api/data`,
  reaching `/api/admin/*` without being an admin, creating a profile without a valid code while
  `INVITE_ONLY=1`, or anything that reaches the Supabase secret key from outside the server.
- **`supabase/migrations/`** — a grant or a missing `enable row level security` that makes a
  table reachable with the project's publishable/anon key.
- **Frontend** — XSS in the React app, or anything that lets a page on another origin read or
  change a signed-in user's data.
- **Shipped deployment config** — `docker-compose.yml`, `web/nginx.conf`, the two Dockerfiles:
  a default that exposes something a self-hoster wouldn't expect to be exposed.

## Out of scope

- Anything that already assumes access to the host, to `./data`, to the Docker socket, or to the
  Supabase project's dashboard or secret key. The operator is trusted by design — see the
  security model below.
- Supabase's own infrastructure. Report those to
  [Supabase](https://supabase.com/.well-known/security.txt), not here.
- Admins reading their users' workout history. That is the documented purpose of the admin
  dashboard, not a leak.
- **Missing rate limiting**, brute force, or "I sent 100k requests and it got slow". The app
  has no rate limiting at all and doesn't pretend to; that belongs in the reverse proxy you put
  in front of it. Genuine amplification (one small request causing unbounded work) *is* in scope.
- **Missing security headers** (CSP, HSTS, X-Frame-Options) — `web/nginx.conf` sets none; TLS
  and headers are the reverse proxy's job. A concrete attack that headers would have stopped is
  still worth reporting.
- Instances served over plain `http://` on a LAN IP. Unsupported: the session cookie isn't
  marked `Secure` there, and push and wake lock don't work at all.
- Scanner output with no working exploit, and `npm audit` findings in build-time
  devDependencies (Vite, Vitest, Capacitor CLI) that never reach a running instance.
- The GitHub Pages demo build — it has no backend at all, everything stays in that browser.
- Third-party content: the exercise image/GIF dataset and the CDN it's fetched from.

## Security model

Read this before hosting openGym for anyone other than yourself.

### What it does

- **Supabase Auth owns credentials.** Email addresses and password hashes live in Supabase's
  `auth.users`; this server never stores or sees a password at rest. Sign-in posts the pair to
  Supabase's token endpoint and keeps only the returned user id (`api/supabase.js` →
  `passwordGrant`, `api/server.js:347`). Minimum length is 8 characters (`api/server.js:30`) and
  a wrong password and an unknown address give the same answer, so the API doesn't tell an
  attacker which addresses have profiles (`api/server.js:356`).
- **The browser never holds a Supabase credential.** It talks only to this app's own `/api` on
  the same origin. The project's secret key is read by the `api` container alone, and the four
  tables grant nothing to the `anon`/`authenticated` roles, with row level security enabled and
  no policies as a second lock (`supabase/migrations/*_opengym_backend.sql`).
- **Changing a password proves the old one first** (`api/server.js:369`), and the address it
  checks against comes from Supabase rather than the request, so the route can't be turned into
  a way of testing someone else's credentials.
- **Sessions are a signed cookie.** `gymsid` carries `<uid>:<expiry>:<version>` plus an
  HMAC-SHA256 tag over it, compared in constant time (`api/server.js:198-206`). The key is 32
  random bytes generated on first run and written to `./data/secret` with mode `0600`
  (`api/server.js:43`). The cookie is `HttpOnly` and `SameSite=Lax`, and gets `Secure` **only
  when `ORIGIN` starts with `https:`** (`api/server.js:29`, `api/server.js:243-245`). Supabase's
  own access token is never sent to the browser and never stored.
- **Any user can end every session they have.** `POST /api/logout/all` increments that account's
  `session_version` in Postgres, and every authenticated request compares the version in the
  cookie against it (`api/server.js:233`, `api/server.js:392`), so every cookie ever issued for
  the account — on every device, including a copy someone walked off with — stops verifying at
  once. The password is untouched; signing back in works immediately.
- **Data is isolated per user by the session's uid.** `GET`/`PUT /api/data` only ever read or
  write the caller's own `user_state` row (`api/server.js:403-419`); no route lets a normal user
  name another user.
- **Disabling an account takes effect immediately.** Every authenticated request and every login
  is rejected for a disabled user (`api/server.js:229`, `api/server.js:363`).

### What it does not do

- **Nothing is encrypted at rest, in either place.** The Supabase project holds every profile's
  complete workout history and body-weight log in `user_state`, readable by anyone with the
  project's dashboard or secret key. `./data` holds `secret`, `vapid.json`, the Coach's job
  records, and a plain-text mirror of every profile's state; with `secret` alone, anyone who can
  read that folder can mint a valid session cookie for any account. **If you host openGym for
  other people, they are trusting you exactly as much as they'd trust any server operator** —
  and now also trusting Supabase as your database host.
- **The secret key is the whole database.** It bypasses row level security by design. Anything
  that leaks it — a committed `.env`, a log line, a backup, a compromised host — hands over every
  account, and rotating it in the Supabase dashboard is the only fix. It is deliberately never
  put in a browser, never logged, and never passed to a Coach subprocess
  (`api/coach/config.js` → `jobEnv`, asserted in `api/test/config.test.js`).
- **Admins can read everything.** A user listed in `ADMIN_UIDS` (or with `admin = true` in the
  `profiles` table) gets every user's full history and body weight plus their email address, can
  disable accounts, and can create or revoke invite codes (`api/server.js:494-580`). Off by
  default — a fresh instance has no admin.
- **Sessions can't be revoked one device at a time.** Revocation is per *account*, not per
  session: `POST /api/logout/all` kills all of them at once and there is no device list to pick
  from. `POST /api/logout` on its own only clears the cookie in that one browser
  (`api/server.js:385`) — a copy taken beforehand keeps working. Sessions last **90 days** by
  default, settable with `SESSION_DAYS` (`api/server.js:26`); each cookie carries the lifetime it
  was issued with, so changing the setting doesn't reach cookies that are already out. Changing a
  password does **not** end other sessions either — use "Sign out everywhere" for that. Deleting
  `./data/secret` and restarting still works as the instance-wide reset, and disabling an account
  still locks out one user completely.
- **CSRF protection is `SameSite=Lax` and nothing else.** There are no CSRF tokens.
- **Email addresses are not verified.** Accounts are created already confirmed
  (`email_confirm: true` in `api/supabase.js`), because hosted Supabase's built-in mailer sends
  only a couple of messages an hour and a personal instance usually has no SMTP. Anyone can sign
  up with an address that isn't theirs. Connect real SMTP to the project and drop that flag if
  that matters to you.
- **There is no password reset.** No SMTP, no reset flow. The operator sets a new password under
  **Authentication → Users** in the Supabase dashboard.
- **No multi-factor, and no password strength rule beyond 8 characters** (`api/server.js:30`).
  Supabase supports both; neither is wired up here.
- **Disabling someone isn't a ban.** They can still register a fresh profile with another email
  address unless `INVITE_ONLY=1` is set.
- **HTTPS is required and the app doesn't provide it.** The API container speaks plain HTTP and
  nginx listens on `:80` (`web/nginx.conf`); TLS is your reverse proxy's job. Without it the
  session cookie — and the password on its way to `/api/login` — travel in the clear, and push
  and wake lock don't work at all (except on `http://localhost`).
- **No rate limiting anywhere.** Nothing throttles logins, registrations or writes. With
  passwords rather than passkeys this now matters more than it used to: **put a rate limit in
  front of `/api/login` on any instance reachable from the open internet.** `POST /api/register`
  also answers whether an invite code is valid (`api/server.js:318`), so the same applies there.
  Invite codes are 16 hex characters — 64 bits (`api/server.js:567`) — which makes guessing one
  impractical even unthrottled. The only hard limit in the app is a 5 MB request body
  (`api/server.js:27`).
- **A few endpoints answer without a session:** `/api/health` (which includes the total user
  count), `/api/config` (whether invite-only is on and the minimum password length),
  `/api/push/public-key`, and `/api/register` / `/api/login` themselves.
- **The account cache is up to 60 seconds stale.** Profiles and push subscriptions are held in
  memory and reloaded on a timer (`api/server.js:59`). Changes made through the app update it
  immediately, but editing the `profiles` table straight in the Supabase dashboard — disabling
  someone, say — can take up to a minute to take effect.
- **Guest mode never reaches the backend.** That data lives unencrypted in the browser's
  `localStorage` and is gone when the browser storage is cleared.
