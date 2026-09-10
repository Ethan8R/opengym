-- Live "training now" presence for the admin dashboard.
--
-- The container build keeps this in a Map in memory, because it is ephemeral by nature: a
-- heartbeat while a workout is on screen, expired a minute after the last ping. Serverless has no
-- memory between requests, so on the Vercel deployment it has to be a table. Readers filter on
-- `updated_at` rather than trusting rows to be tidied up, so a client that vanishes mid-workout
-- simply stops appearing.
--
-- Safe to apply to a container-only instance too: nothing writes to it there.

create table public.presence (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  name       text        not null default '',
  ex_idx     integer     not null default 0,
  ex_total   integer     not null default 0,
  sets_done  integer     not null default 0,
  sets_total integer     not null default 0,
  -- Client-supplied epoch milliseconds for when the workout started, used only to show elapsed
  -- time. bigint because it does not fit in an integer.
  started_at bigint      not null default 0,
  updated_at timestamptz not null default now()
);

-- The only query is "who has pinged recently", so that is the index.
create index presence_updated_at_idx on public.presence (updated_at desc);

-- Same access model as every other table: reachable only with the project's secret key.
alter table public.presence enable row level security;
grant select, insert, update, delete on public.presence to service_role;
