-- openGym on Supabase — accounts, per-profile state, push subscriptions, invite codes.
--
-- Identity itself lives in `auth.users` (Supabase Auth owns the email, the password hash and
-- confirmation state). Everything here hangs off that row and is reached *only* by the openGym
-- API using the project's secret key. The browser never holds a Supabase key and never talks to
-- PostgREST, so `anon` and `authenticated` are granted nothing at all: RLS is on with no policies
-- and the grants below stop at `service_role`. That is the whole access model — the API is the
-- boundary, and these tables are unreachable without the secret key.

/* ---------- profiles ---------- */
-- The openGym-side half of an account. `auth.users` has no room for a display name, an operator
-- kill switch or a session counter, so they live here, one row per user, created by the API at
-- sign-up and dropped with the auth row.
create table public.profiles (
  id              uuid primary key references auth.users (id) on delete cascade,
  name            text        not null,
  created_at      timestamptz not null default now(),
  -- Operator switch from the admin dashboard: refuses new sign-ins and kills existing sessions.
  disabled        boolean     not null default false,
  -- Admin flag stored per profile. ADMIN_UIDS in the environment still works and is OR-ed with it.
  admin           boolean     not null default false,
  -- "Sign out everywhere": bumping this invalidates every session cookie ever minted for the
  -- account, because the value it was minted with is baked into the cookie.
  session_version integer     not null default 0,
  -- Date (in the user's own zone) the workout-day reminder last fired, so it fires once a day.
  last_reminder   date,
  invited_by      text
);

/* ---------- per-profile state ---------- */
-- The whole app state — plan, routines, workouts, body weight, settings — as one JSON document,
-- exactly the shape the client already syncs. One row per profile, last write wins, which is what
-- the file-backed version did too.
create table public.user_state (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  state      jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

/* ---------- web push subscriptions ---------- */
-- Keyed by endpoint because that is what the push service hands back, and what a 404/410 on send
-- identifies when a dead subscription has to be pruned.
create table public.push_subscriptions (
  endpoint   text primary key,
  user_id    uuid        not null references auth.users (id) on delete cascade,
  keys       jsonb       not null,
  created_at timestamptz not null default now()
);
create index push_subscriptions_user_id_idx on public.push_subscriptions (user_id);

/* ---------- invite codes ---------- */
-- Only consulted when INVITE_ONLY is set. A code is spent by setting used_by/used_at; revoking
-- deletes the row, which is why revoke refuses once a code has been used.
create table public.invites (
  code       text primary key,
  note       text        not null default '',
  created_by uuid        references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  used_by    uuid        references auth.users (id) on delete set null,
  used_at    timestamptz
);
create index invites_used_by_idx on public.invites (used_by);

/* ---------- access control ---------- */
-- RLS on, deliberately with zero policies: no policy means no row is visible to any role that is
-- subject to RLS. `service_role` bypasses RLS, so the API still sees everything.
alter table public.profiles           enable row level security;
alter table public.user_state         enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.invites            enable row level security;

-- Since 2026 new projects do not expose public tables to the Data API automatically, and that
-- includes service_role, so the API's own access has to be granted explicitly. anon and
-- authenticated are intentionally left out — nothing here is reachable from a browser.
grant select, insert, update, delete on public.profiles           to service_role;
grant select, insert, update, delete on public.user_state         to service_role;
grant select, insert, update, delete on public.push_subscriptions to service_role;
grant select, insert, update, delete on public.invites            to service_role;
