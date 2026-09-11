# Setting up Supabase

openGym keeps accounts and training data in a [Supabase](https://supabase.com) project:
Supabase Auth owns the email addresses and password hashes, and four tables in Postgres hold
profiles, each profile's state, push subscriptions and invite codes.

This takes about five minutes, once. The free tier is enough for a personal or family instance.

---

## 1. Create the project

1. Sign in at [supabase.com/dashboard](https://supabase.com/dashboard) and click **New project**.
2. Give it a name, set a database password (save it in your password manager — you'll want it
   for backups), and pick the region closest to you.
3. Wait for provisioning to finish, a minute or two.

## 2. Apply the schema

The schema is in this repo at `supabase/migrations/`. Either way works.

### Option A — the SQL editor (no tools to install)

Open **SQL Editor** in the dashboard, paste the entire contents of
`supabase/migrations/20260910000611_opengym_backend.sql`, and run it. It should report success
with no rows.

### Option B — the Supabase CLI

```bash
supabase login
supabase link --project-ref <your-project-ref>   # the ref is in the dashboard URL
supabase db push
```

Either way, check **Table Editor** afterwards: you should see `profiles`, `user_state`,
`push_subscriptions` and `invites`, each marked as having row level security enabled.

## 3. Turn off email confirmation

openGym creates accounts already confirmed, so nobody waits on an email that a personal instance
has no mail server to send. Nothing to change for that to work — but while you are here, under
**Authentication → Sign In / Providers**, make sure **Email** is enabled and leave the rest off.

If you later connect real SMTP and want addresses verified for real, remove `email_confirm: true`
from `createAccount` in `api/supabase.js`.

## 4. Copy the two keys into `.env`

In the dashboard:

| Value | Where | Goes in `.env` as |
|---|---|---|
| Project URL | **Project Settings → Data API** | `SUPABASE_URL` |
| Secret key (`sb_secret_…`, called *service_role* on older projects) | **Project Settings → API Keys** | `SUPABASE_SECRET_KEY` |

```bash
SUPABASE_URL=https://abcdefghijklm.supabase.co
SUPABASE_SECRET_KEY=sb_secret_xxxxxxxxxxxxxxxxxxxxxxxx
```

> **The secret key bypasses every access rule in the database.** Only the `api` container reads
> it, and it is never sent to a browser. Keep it out of git (`.env` is already ignored) and
> rotate it in the dashboard if it ever leaks. The publishable/anon key is not used by openGym
> at all — the tables grant it nothing.

Then start the stack:

```bash
docker compose up -d --build
```

`docker compose logs api` should print how many profiles it loaded. If it exits instead, the URL
or the key is wrong.

---

## How the pieces fit

```
browser ──HTTPS──> web (nginx) ──/api──> api (Node) ──secret key──> Supabase
                                            │
                                            └─ ./data — session secret, VAPID keys,
                                               Coach job records, state mirror
```

The browser never holds a Supabase key and never talks to Supabase directly. It signs in against
openGym's own `/api/login`, which checks the password with Supabase Auth and then sets the same
signed `HttpOnly` cookie the app has always used. That is why the tables grant nothing to the
`anon` and `authenticated` roles: the API is the only way in, and row level security is enabled
with no policies as a second lock on the same door.

### The tables

| Table | Holds |
|---|---|
| `profiles` | Display name, admin flag, disabled flag, session counter — one row per account in `auth.users` |
| `user_state` | The whole app state (plan, routines, workouts, weigh-ins, settings) as one JSON document per profile |
| `push_subscriptions` | Web Push endpoints, keyed by endpoint so re-subscribing a browser replaces the old row |
| `invites` | Invite codes, and who spent them |

Deleting a user under **Authentication → Users** cascades: their profile, state, subscriptions
and invite links go with them.

### What stays on disk

`./data` is still there, and still worth mounting on a volume, but it holds no training data:

- `secret` — signs session cookies, and derives the key the AI Coach encrypts its provider
  credential with. Delete it and everyone is signed out.
- `vapid.json` — the push keypair, generated on first run.
- `coach/` and `coach.json` — Coach job records and instance configuration.
- `state-<uuid>.json` — a read-only mirror of each profile's state, refreshed on every sync.
  The reminder scheduler and the Coach read it because they run outside a request and cannot
  wait on the network. Postgres is always the source of truth; deleting these is harmless.

## Common problems

| Symptom | Cause |
|---|---|
| API exits with "openGym needs a Supabase project" | `SUPABASE_URL` or `SUPABASE_SECRET_KEY` is empty in `.env`. |
| `relation "public.profiles" does not exist` | Step 2 was skipped, or run against a different project. |
| `permission denied for table profiles` | The key in `.env` is the publishable/anon key, not the secret one. |
| Sign-up returns "Email address is invalid" | Supabase rejects some throwaway domains. Use a real address. |
| Forgot a password | Set a new one under **Authentication → Users**. Self-serve reset needs SMTP configured on the project. |
