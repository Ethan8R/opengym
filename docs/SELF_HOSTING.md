# Self-hosting openGym

openGym is two small containers (a web server and an API), a Supabase project holding the
accounts and training data, and a small folder of local runtime files.
This guide takes you from "just cloned it" to "using it from my phone over the internet".

## 0. Create the Supabase project (first, once)

Accounts and workout data live in Supabase, so set that up before starting the containers:
**[docs/SUPABASE.md](SUPABASE.md)**. It takes about five minutes and the free tier is enough.
You come back here with two values for `.env`, `SUPABASE_URL` and `SUPABASE_SECRET_KEY`.

## 1. Run it locally (5 minutes)

Requirements: [Docker](https://docs.docker.com/get-docker/) with the Compose plugin.

```bash
git clone https://github.com/DuarteSantos8/gym-app opengym
cd opengym
cp .env.example .env
$EDITOR .env          # paste SUPABASE_URL and SUPABASE_SECRET_KEY
docker compose up -d --build
```

- First start downloads the exercise images/GIFs (~140 MB) once into `app/img` and `app/gif`.
- Open **http://localhost:8080** and create a profile with an email and a password.
- This fork builds from source rather than pulling the upstream images: its API talks to
  Supabase, so the published `opengym-api` image is a different server and would not work.

Check it's healthy:

```bash
docker compose ps
curl http://localhost:8080/api/health      # {"ok":true,...}
```

Logs: `docker compose logs -f`. Stop: `docker compose down`.

## 2. Where HTTPS still matters

Signing in works anywhere, including over a plain LAN address — an email and a password are not
tied to a hostname. Two features are, because browsers only offer them on a secure origin
(`https://…`, or `http://localhost`):

- **Push notifications** — rest-timer alerts and the workout-day reminder.
- **Keep screen awake** during a workout.

Over `http://<your-LAN-ip>:8080` those two switches show as unsupported, and the session cookie
cannot be marked `Secure`. Everything else behaves normally. For daily use from a phone, and for
anything reachable outside your own network, set up a real HTTPS hostname — that's section 3.

## 3. Expose it over HTTPS on your own domain

Put openGym behind something that terminates TLS for a hostname you control, then point it at
the `web` container. Pick whichever you already run:

### Option A — Cloudflare Tunnel (no open ports)

1. Create a tunnel and route `gym.example.com` → `http://<docker-host>:8080`.
2. Cloudflare gives you HTTPS automatically.

### Option B — Caddy (automatic Let's Encrypt)

```caddy
gym.example.com {
    reverse_proxy localhost:8080
}
```

### Option C — Traefik / nginx / Nginx Proxy Manager

Route `gym.example.com` (HTTPS) → `web:80` (or `<docker-host>:8080`). Any reverse proxy works —
openGym only needs the browser to reach it over `https://gym.example.com`.

Then set your domain in `.env` and restart:

```bash
# .env
ORIGIN=https://gym.example.com
WEB_PORT=8080
```

```bash
docker compose up -d --build
```

Visit `https://gym.example.com`, create your profile, and add it to your home screen
(iOS: Share → Add to Home Screen · Android: ⋮ → Add to Home screen).

> `ORIGIN` has to match the address people actually type — it is what marks the session cookie
> `Secure`. Changing it later is safe: accounts live in Supabase and are not bound to a hostname.

## 4. Multiple users

Anyone who can reach the URL can create their own profile — each gets isolated data. That's the
default: open signup, no admin.

If you'd rather control who gets in, two optional settings in `.env` turn that around:

```bash
ADMIN_UIDS=00000000-0000-0000-0000-000000000000   # comma-separated; these users get the dashboard
INVITE_ONLY=1                                      # new profiles need an invite code
```

Create your own profile first, then find its id in the Supabase dashboard — **Table Editor →
`profiles`**, or **Authentication → Users** — and put it in `ADMIN_UIDS`. Setting that row's
`admin` column to `true` instead does the same thing and needs no restart. You'll get an **Admin dashboard** link in Settings: who's training
right now, each user's workout history and body weight, the ability to disable an account (signed
out and locked out everywhere until you re-enable it), and — with `INVITE_ONLY=1` — generating and
revoking invite codes. Existing accounts keep working when you switch invite-only on. Admin access
is gated by your own sign-in and enforced server-side, so it needs no separate login.

Prefer to keep the whole thing off the open internet? A VPN or an auth proxy (Authelia, Cloudflare
Access…) in front still works, and composes with the above.

## 5. Backups

Profiles and training data are in Supabase, so that is what to back up. Paid projects take
automatic daily backups; on the free tier, dump it yourself:

```bash
supabase db dump --db-url "$SUPABASE_DB_URL" -f opengym-$(date +%F).sql
```

(The connection string is in the dashboard under **Connect**. Treat the dump like the database:
it contains everyone's training history.)

`./data` is worth keeping too, but it holds no training data — the session secret, the VAPID
keypair, the Coach's job records and its encrypted provider credential, plus a disposable mirror
of each profile's state:

```bash
tar czf opengym-runtime-$(date +%F).tar.gz data/
```

Losing it signs everyone out and disconnects the Coach; nobody's history is affected. (Individual
users can also export their own data as JSON from Settings.)

## 6. Notifications

openGym can push two kinds of alert to your phone/desktop, even when the app isn't open:
rest-timer-over, and a reminder on days you have a workout planned but haven't logged one yet.
Turn it on per-profile in **Settings → Notifications** (requires a signed-in profile and
HTTPS — see section 2).

No setup needed server-side, and nothing to configure per timezone: VAPID keys are generated on
first run and saved to `./data/vapid.json`, and each user's browser reports its own timezone
automatically when they turn the reminder on — it fires at their local time, and follows them if
they travel, regardless of what timezone the server itself runs in.

**Keep screen awake** (Settings → *During a workout*) has the same transport requirement: the
Wake Lock API is only available over HTTPS or on `http://localhost`, so on a plain-LAN-IP
instance the switch shows as unsupported. Nothing to configure server-side either way, and iOS
refuses the lock while the phone is in Low Power Mode.

## 7. Updating

Running prebuilt images:

```bash
git pull                    # picks up compose/config changes
docker compose pull
docker compose up -d
```

Building from source instead:

```bash
git pull
docker compose up -d --build
```

The app shell is versioned (`?v=N`) so clients pick up changes on next load. Your `./data` and the
downloaded media are untouched.

## 8. The AI Coach (optional)

The Coach is an AI that designs training plans and reviews them against what your users
actually log. It is **off on a fresh instance**, and turning it on is entirely a dashboard job
— there is nothing to install and nothing to put in `.env`.

### What you are signing up for

The account is yours: every plan or review is one session on the provider account you connect,
so budget for it and use the caps below. The built-in choices are Claude's official Agent SDK
and a pinned OpenAI Codex CLI. Neither requires an API key: Claude uses an owner-created setup
token, while Codex uses ChatGPT's device-code sign-in and stores its refreshable CLI cache only
in the private `./data/codex` volume. Use the Codex option only on a trusted, owner-controlled
server; that cache is equivalent to a password and must not be exposed to users or public code.

### Turning it on

1. Open **Settings → Admin dashboard → AI Coach** and flip the switch.
2. Pick one built-in provider:
   - **Claude Code**: on a trusted computer where you use Claude Code, run `claude setup-token`.
     Complete its normal browser sign-in, copy the printed token, then choose **Add CLI token**
     in openGym. The token is encrypted at rest and passed only to the isolated Agent SDK job.
   - **OpenAI Codex CLI**: choose **Sign in with ChatGPT**, then use the link and one-time code
     on a trusted browser or iPad. This is Codex's device-code login; openGym never receives a
     ChatGPT password, API key, browser callback, or access token. Its private CLI cache lives
     in `./data/codex` and is refreshed by Codex itself.
3. Hit **Test the Coach**. Green means a real round-trip to the selected provider worked.

The card then shows the runtime, credential state, jobs run today and the last failure, if any.
For the complete no-API-key Codex flow, see [ChatGPT-setup-instructions.md](../ChatGPT-setup-instructions.md).

### Limits

Set a per-user daily cap (default 10) and, on a shared instance, an instance-wide one. Both
are in the same card; `0` means no limit. Nothing else meters spend, so these are worth
setting before you hand the instance to a family.

### What your users see

Nothing, until they opt in. Each profile gets a **Meet the Coach** card explaining exactly
which categories of their data would leave the server, naming the provider, and stating that
it runs under your account. Declining leaves the app exactly as it was.

You cannot read their intake answers, their payloads or their proposals — the admin card shows
counts, timings and error classes only. That is deliberate: enabling a feature and reading
people's training notes are different powers.

### What leaves the box

Only the profile that asked, and only: their plan, the training window under review, their
weigh-ins and goal weight, their intake answers, and their unit/language/effort scale. Names,
credentials, push subscriptions and every other profile's data stay here. The job itself runs as
an unprivileged user that cannot read `./data` at all — the CLI sees its own payload and
nothing else.

### Trying it without an account

Select the **Fixture (testing)** provider. It answers with a canned but structurally real
proposal, so you can walk the whole loop — intake, proposal, accept, revert — before
connecting anything that costs money.

### When it breaks

| Symptom | Fix |
|---|---|
| "The Coach couldn't sign in to its provider" | For Claude, replace the setup token. For Codex, disconnect and complete **Sign in with ChatGPT** again. |
| "The Coach isn't installed properly" | A bundled provider runtime is missing — rebuild the API image with `docker compose up -d --build`. |
| "The Coach is resting" | A daily cap was hit. Raise it, or wait. |
| "answered with something the app couldn't use" | The model produced output that failed validation twice. Usually transient; try again. |
| Everything is grey and says force-disabled | `COACH_DISABLED=1` is set in the environment. |

Users never see the provider's own error text — that goes to the admin card, where someone can
act on it.

## Troubleshooting

| Symptom | Fix |
|---|---|
| API container exits at startup | `SUPABASE_URL` / `SUPABASE_SECRET_KEY` are missing or wrong in `.env`. `docker compose logs api` says which. |
| Sign-up fails with a table error | The schema was never applied to the project — see [docs/SUPABASE.md](SUPABASE.md). |
| Signed in but "profile missing" | The row in `profiles` was deleted while the account in Supabase Auth remains. Delete the user under Authentication → Users and sign up again. |
| Media didn't download | `docker compose logs media`. Re-run `docker compose up -d`, or run `./scripts/fetch-media.sh`. |
| Port 8080 already used | Set `WEB_PORT=9090` in `.env` (and update `ORIGIN` for local testing). |
| No "Notifications" option in Settings | Requires a signed-in profile and HTTPS (or `localhost`) — guest mode and plain HTTP over LAN can't subscribe. |
| Day reminder fires at the wrong time | Toggle it off and on in Settings so it re-detects your browser's timezone (also happens automatically on every app load — see section 6). |
| Want to reset a stuck login | Delete the cookie in your browser; sessions are just signed cookies. |
| Forgot a password | No self-serve reset yet (it needs SMTP). Set a new one for the user under **Authentication → Users** in the Supabase dashboard. |
