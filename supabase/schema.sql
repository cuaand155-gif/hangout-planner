-- Waddle database schema.
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

-- Keep a profile row for every account, so friend requests can show a name
-- instead of a bare email address.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(new.email, '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Living in the public schema would also expose this at
-- /rest/v1/rpc/handle_new_user. Postgres checks EXECUTE when a trigger is
-- created rather than each time it fires, so the trigger still works.
revoke execute on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Friend requests
-- ---------------------------------------------------------------------------
-- One row per request. A friendship is simply a row whose status is
-- 'accepted', so there is no second table to keep in step.
--
-- Requests are addressed to an email rather than a user id, so you can invite
-- somebody who has not signed up yet: recipient_id stays null until they
-- accept. That is also why the policies below match on the email in the
-- caller's token as well as on their id.

create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users(id) on delete cascade,
  recipient_email text not null check (position('@' in recipient_email) > 1),
  recipient_id uuid references auth.users(id) on delete cascade,
  note text,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  constraint friend_requests_not_self check (requester_id is distinct from recipient_id)
);

-- Stops the same pair stacking up duplicate live requests. A declined request
-- is excluded, so somebody can ask again later.
create unique index if not exists friend_requests_live_pair
  on public.friend_requests (requester_id, lower(recipient_email))
  where status in ('pending', 'accepted');

create index if not exists friend_requests_recipient_email
  on public.friend_requests (lower(recipient_email));

alter table public.friend_requests enable row level security;

-- You can read a request only if you sent it or it is addressed to you. The
-- email comparison uses the address inside the caller's own token, so nobody
-- can read requests by guessing at someone else's address.
drop policy if exists "Requests are visible to both sides" on public.friend_requests;
create policy "Requests are visible to both sides"
  on public.friend_requests for select to authenticated
  using (
    auth.uid() = requester_id
    or auth.uid() = recipient_id
    or lower(recipient_email) = lower(auth.jwt() ->> 'email')
  );

drop policy if exists "Users send their own requests" on public.friend_requests;
create policy "Users send their own requests"
  on public.friend_requests for insert to authenticated
  with check (
    auth.uid() = requester_id
    and recipient_id is null
    and lower(recipient_email) <> lower(coalesce(auth.jwt() ->> 'email', ''))
  );

-- Only the recipient answers a request, and answering cannot rewrite who it
-- was from or who it was for. A policy's WITH CHECK cannot see the old row, so
-- the second half of that is enforced with column privileges: a signed-in
-- caller may only ever update the three columns answering touches. Without
-- this, a recipient could accept a request and restate it as coming from
-- somebody else, inventing a friendship that person would then see.
revoke update on public.friend_requests from authenticated, anon;
grant update (status, recipient_id, responded_at) on public.friend_requests to authenticated;

drop policy if exists "Recipients answer their requests" on public.friend_requests;
create policy "Recipients answer their requests"
  on public.friend_requests for update to authenticated
  using (
    auth.uid() = recipient_id
    or lower(recipient_email) = lower(auth.jwt() ->> 'email')
  )
  with check (
    auth.uid() = recipient_id
    and status in ('accepted', 'declined')
  );

-- A sender can withdraw a request; a recipient can drop one aimed at them.
drop policy if exists "Either side can remove a request" on public.friend_requests;
create policy "Either side can remove a request"
  on public.friend_requests for delete to authenticated
  using (
    auth.uid() = requester_id
    or auth.uid() = recipient_id
    or lower(recipient_email) = lower(auth.jwt() ->> 'email')
  );

-- ---------------------------------------------------------------------------
-- Calendar shares
-- ---------------------------------------------------------------------------
-- What one person lets one friend see of their calendar. The owner's browser
-- decides the contents (busy blocks only, or with the event names they chose)
-- and writes one row per friend; a friend set to "Nothing" simply has no row.
-- Full calendars never reach the database, only these filtered copies.

create table if not exists public.calendar_shares (
  owner_id uuid not null references auth.users(id) on delete cascade,
  viewer_id uuid not null references auth.users(id) on delete cascade,
  events jsonb not null default '[]'::jsonb
    check (jsonb_typeof(events) = 'array' and pg_column_size(events) < 200000),
  updated_at timestamptz not null default now(),
  primary key (owner_id, viewer_id),
  constraint calendar_shares_not_self check (owner_id <> viewer_id)
);

create index if not exists calendar_shares_viewer on public.calendar_shares (viewer_id);

alter table public.calendar_shares enable row level security;

-- Only the two people on a row can read it.
drop policy if exists "Shares are visible to owner and viewer" on public.calendar_shares;
create policy "Shares are visible to owner and viewer"
  on public.calendar_shares for select to authenticated
  using (auth.uid() = owner_id or auth.uid() = viewer_id);

-- Only the owner writes, and only to somebody who is actually their friend:
-- an accepted request between the two, in either direction. The caller can
-- read that request under its own policy, so no elevated function is needed.
drop policy if exists "Owners share with their friends" on public.calendar_shares;
create policy "Owners share with their friends"
  on public.calendar_shares for insert to authenticated
  with check (
    auth.uid() = owner_id
    and exists (
      select 1 from public.friend_requests fr
      where fr.status = 'accepted'
        and ((fr.requester_id = owner_id and fr.recipient_id = viewer_id)
          or (fr.requester_id = viewer_id and fr.recipient_id = owner_id))
    )
  );

drop policy if exists "Owners update their shares" on public.calendar_shares;
create policy "Owners update their shares"
  on public.calendar_shares for update to authenticated
  using (auth.uid() = owner_id)
  with check (
    auth.uid() = owner_id
    and exists (
      select 1 from public.friend_requests fr
      where fr.status = 'accepted'
        and ((fr.requester_id = owner_id and fr.recipient_id = viewer_id)
          or (fr.requester_id = viewer_id and fr.recipient_id = owner_id))
    )
  );

-- The owner can stop sharing at any time, and a viewer can drop a share they
-- no longer want to see.
drop policy if exists "Either side can remove a share" on public.calendar_shares;
create policy "Either side can remove a share"
  on public.calendar_shares for delete to authenticated
  using (auth.uid() = owner_id or auth.uid() = viewer_id);

-- A friendship that ends takes its shares with it.
create or replace function public.drop_shares_for_ended_friendship()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_op = 'DELETE' and old.status = 'accepted')
     or (tg_op = 'UPDATE' and old.status = 'accepted' and new.status <> 'accepted') then
    delete from public.calendar_shares
    where (owner_id = old.requester_id and viewer_id = old.recipient_id)
       or (owner_id = old.recipient_id and viewer_id = old.requester_id);
  end if;
  return null;
end;
$$;

revoke execute on function public.drop_shares_for_ended_friendship() from public, anon, authenticated;

drop trigger if exists friend_requests_drop_shares on public.friend_requests;
create trigger friend_requests_drop_shares
  after update or delete on public.friend_requests
  for each row execute function public.drop_shares_for_ended_friendship();

-- ---------------------------------------------------------------------------
-- Notes on tables this schema no longer creates
-- ---------------------------------------------------------------------------
-- Earlier prototypes had friendships, friend_invites and calendar_connections.
-- They are replaced or unused:
--   * friendships and friend_invites are superseded by friend_requests above,
--     which the app actually reads, answers and acts on;
--   * group membership lives in workspaces.state.members, so a workspace still
--     works for people who never sign in;
--   * calendar links stay in the browser's local storage on purpose, so a
--     secret ICS address is never uploaded. Only the busy blocks are shared.
-- If an earlier version of this schema created those tables, they are simply
-- unused; drop them by hand if you want them gone.
