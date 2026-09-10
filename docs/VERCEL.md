# Deploying openGym to Vercel

This repo can be deployed two ways, and they are not the same product:

| | **Containers** (`docker compose`) | **Vercel** (this guide) |
|---|---|---|
| Backend | `api/server.js`, always running | `frontend/api/`, serverless functions |
| AI Coach | ✅ | ❌ not possible |
| Rest-timer alerts when the app is closed | ✅ | ❌ not possible |
| Workout-day reminders | ✅ at the exact minute | ⚠️ once a day on the free plan, exact minute on Pro |
| "Training now" in the admin dashboard | ✅ | ✅ |
| Everything else | ✅ | ✅ |

Both read and write the same Supabase project, so an account created on one works on the other.

## Why the gaps

Vercel runs a function when a request arrives and stops it immediately afterwards. Three things
in openGym need a process that stays up:

- **The AI Coach** launches a provider CLI as a child process and lets it think for up to five
  minutes. There is nothing to launch it from and no five minutes to spend. `/api/config` on this
  deployment never reports a Coach, and every Coach screen in the app hangs off that flag, so the
  feature is invisible rather than broken.
- **Rest-timer alerts** are a `setTimeout` 90 seconds into the future. Nothing is alive to fire it.
  The on-screen rest timer is client-side and works exactly as before; only the push you'd get
  with the phone locked is gone. Settings says so under Notifications.
- **Workout-day reminders** were a sweep every ten seconds. They are a cron job here — see below.

If any of those matter more than the URL, deploy the containers instead:
[docs/SELF_HOSTING.md](SELF_HOSTING.md).

---

## 1. Add the presence table to Supabase

The serverless build has no memory between requests, so "who is training right now" needs a table.
Open **SQL Editor** in your Supabase dashboard and run
`supabase/migrations/20260910212450_live_presence.sql`, or paste this:

```sql
create table public.presence (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  name       text        not null default '',
  ex_idx     integer     not null default 0,
  ex_total   integer     not null default 0,
  sets_done  integer     not null default 0,
  sets_total integer     not null default 0,
  started_at bigint      not null default 0,
  updated_at timestamptz not null default now()
);
create index presence_updated_at_idx on public.presence (updated_at desc);
alter table public.presence enable row level security;
grant select, insert, update, delete on public.presence to service_role;
```

(Everything else — `profiles`, `user_state`, `push_subscriptions`, `invites` — is already there
from [docs/SUPABASE.md](SUPABASE.md).)

## 2. Generate the two secrets Vercel needs

There is no disk on Vercel, so the session key and the push keypair cannot be generated on first
run and kept — they have to be given as environment variables and then left alone.

```bash
# Session signing key. Changing it later signs everybody out.
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Web Push keypair. Changing it later breaks every existing subscription.
npx web-push generate-vapid-keys
```

Keep both somewhere safe.

## 3. Create the project

Point Vercel at this repository and **set the Root Directory to `frontend`**. That matters: the
functions live in `frontend/api/`, and the repo root's `api/` is the container server, which must
not be built here.

Everything else is already in `frontend/vercel.json` — framework, build command and the cron.

## 4. Set the environment variables

In **Project Settings → Environment Variables**, for Production (and Preview if you use it):

| Name | Value |
|---|---|
| `SUPABASE_URL` | Your project URL, same as `.env` |
| `SUPABASE_SECRET_KEY` | Your Supabase **secret** key, same as `.env` |
| `SESSION_SECRET` | The 64-character hex string from step 2 |
| `VAPID_PUBLIC_KEY` | From step 2 |
| `VAPID_PRIVATE_KEY` | From step 2 |
| `ORIGIN` | `https://your-project.vercel.app` — the address people actually use |
| `CRON_SECRET` | Any long random string; Vercel sends it to the cron endpoint so nobody else can |
| `ADMIN_UIDS` | *(optional)* your profile's uuid, for the admin dashboard |
| `INVITE_ONLY` | *(optional)* `1` to require an invite code |

`SUPABASE_SECRET_KEY` and `SESSION_SECRET` are the two that must never end up in the browser or in
git. They are only ever read by the functions.

Deploy. `https://your-project.vercel.app/api/health` should answer `{"ok":true,...}`. If it
answers with a message about a missing variable, that variable is the problem — the functions say
which one, because there is no startup log on Vercel for anyone to read.

## 5. Workout-day reminders, and the free-plan catch

`frontend/vercel.json` ships with:

```json
"crons": [{ "path": "/api/cron/reminders", "schedule": "0 17 * * *" }]
```

**Free (Hobby) accounts can only run a cron once a day**, with up to an hour of slack either way —
a more frequent schedule *fails the deploy outright*. So on the free plan a reminder arrives once
a day, around 17:00 UTC, for anyone who has a workout planned, hasn't logged one, and whose chosen
time has already passed. Their chosen time is respected as a "not before", not as an appointment.

Change the hour to suit the people using it. On **Pro**, switch it to per-minute and reminders
land at the exact time each person picked, the same as the container build:

```json
"crons": [{ "path": "/api/cron/reminders", "schedule": "* * * * *" }]
```

The endpoint reads Vercel's `x-vercel-cron-schedule` header and adapts on its own — there is no
second setting to change.

## What runs where

```
browser ──> Vercel ──┬─ static app from frontend/dist  (exercise images come from jsdelivr,
                     │                                  so no media is hosted here)
                     └─ frontend/api/[...path].js ──secret key──> Supabase
                        one function, every route              (auth + Postgres)
```

The browser holds no Supabase credential and never talks to Supabase directly, exactly as in the
container build. The session is the same signed `HttpOnly` cookie; only the key's origin changed,
from a file to an environment variable.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Deploy fails: "Hobby accounts are limited to daily cron jobs" | The schedule in `frontend/vercel.json` runs more than once a day. Use a daily one, or upgrade. |
| `/api/health` says a variable is not set | Add it in Project Settings, then redeploy — env changes don't apply to an existing deployment. |
| Everyone gets signed out after a deploy | `SESSION_SECRET` changed or isn't set. It must be the same value for the life of the project. |
| Notifications stopped working after a redeploy | The VAPID keys changed. Restore the originals, or have everyone toggle notifications off and on. |
| `/api/*` returns Vercel's 404 page | Root Directory isn't `frontend`. |
| Functions build but the app is blank | Output directory should be `dist`, build command `npm run build:vercel`. |
| No Coach anywhere | Expected — see the top of this page. |
