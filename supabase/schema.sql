-- Gatherly database schema.
--
-- Run this once in the Supabase SQL editor (paste the contents of this file,
-- not its path). Re-running it is safe: every statement is idempotent.

-- ---------------------------------------------------------------------------
-- Shared workspaces
-- ---------------------------------------------------------------------------
-- One row per planning group. `state` holds the whole workspace document
-- (members, their availability, ideas, the tentative plan, settings), which
-- api/workspace.js validates with normalizeWorkspaceState() before every write.
--
-- `updated_at` doubles as the revision token: a save only lands if the row
-- still carries the revision the client read, so simultaneous editors get a
-- conflict they can retry instead of silently overwriting each other.

create table if not exists public.workspaces (
  slug text primary key,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Row level security with no policy at all is deliberate: browsers never touch
-- this table directly. Only the serverless API, holding the service-role key,
-- can read or write it, and it is the thing that enforces size limits, the
-- workspace lock and the shape of the document.
alter table public.workspaces enable row level security;

-- Workspaces are created on first visit by api/workspace.js, so no seed row is
-- needed here. Visiting /?w=book-club creates "Book club" the first time.

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------
-- Optional: only used once somebody signs in with Google. It carries the
-- profile between devices; the planner works fully signed out as well.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  photo_url text,
  share_schedule boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "Profiles are visible to signed-in users" on public.profiles;
create policy "Profiles are visible to signed-in users"
  on public.profiles for select to authenticated using (true);

drop policy if exists "Users manage their own profile" on public.profiles;
create policy "Users manage their own profile"
  on public.profiles for all to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

-- ---------------------------------------------------------------------------
-- Notes on tables this schema no longer creates
-- ---------------------------------------------------------------------------
-- Earlier prototypes had friendships, friend_invites and calendar_connections.
-- The app does not use them:
--   * group membership lives in workspaces.state.members, so a workspace works
--     for people who never sign in;
--   * calendar links stay in the browser's local storage on purpose, so a
--     secret ICS address is never uploaded. Only the busy blocks are shared.
-- If an earlier version of this schema created those tables, they are simply
-- unused; drop them by hand if you want them gone.
