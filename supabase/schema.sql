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
-- Time-limited shares
-- ---------------------------------------------------------------------------
-- "Show Sam everything this weekend": `events` is what they see until
-- `expires_at`, `fallback_events` what they see afterwards (null: nothing).
-- Viewers can't read either column directly — only through
-- shared_calendars(), which picks by the database clock — so a share ends on
-- time even if the owner's phone never comes back online.

alter table public.calendar_shares
  add column if not exists fallback_events jsonb
    check (fallback_events is null or (jsonb_typeof(fallback_events) = 'array' and pg_column_size(fallback_events) < 200000)),
  add column if not exists expires_at timestamptz;

revoke select on public.calendar_shares from anon, authenticated;
grant select (owner_id, viewer_id, updated_at, expires_at) on public.calendar_shares to authenticated;

-- Writes go through here: without read access to `events`, a plain upsert is
-- refused, and this is also the one place that checks the friendship.
create or replace function public.publish_share(p_viewer uuid, p_events jsonb, p_fallback jsonb default null, p_expires timestamptz default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'sign in first' using errcode = '42501'; end if;
  if p_viewer = me then raise exception 'cannot share with yourself' using errcode = '22023'; end if;
  if not exists (
    select 1 from public.friend_requests fr
    where fr.status = 'accepted'
      and ((fr.requester_id = me and fr.recipient_id = p_viewer) or (fr.requester_id = p_viewer and fr.recipient_id = me))
  ) then raise exception 'only friends can be shared with' using errcode = '42501'; end if;
  if p_expires is not null and p_expires > now() + interval '31 days' then
    raise exception 'a temporary share lasts at most a month' using errcode = '22023';
  end if;
  insert into public.calendar_shares (owner_id, viewer_id, events, fallback_events, expires_at, updated_at)
  values (me, p_viewer, coalesce(p_events, '[]'::jsonb), case when p_expires is null then null else p_fallback end, p_expires, now())
  on conflict (owner_id, viewer_id) do update
    set events = excluded.events, fallback_events = excluded.fallback_events, expires_at = excluded.expires_at, updated_at = excluded.updated_at;
end;
$$;

revoke execute on function public.publish_share(uuid, jsonb, jsonb, timestamptz) from public, anon;
grant execute on function public.publish_share(uuid, jsonb, jsonb, timestamptz) to authenticated;

-- What each friend currently shows you (all of them, or one with p_owner).
create or replace function public.shared_calendars(p_owner uuid default null)
returns table (owner_id uuid, events jsonb, updated_at timestamptz, shared_until timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select s.owner_id,
         case when s.expires_at is null or s.expires_at > now() then s.events else s.fallback_events end,
         s.updated_at,
         case when s.expires_at > now() then s.expires_at end
  from public.calendar_shares s
  where s.viewer_id = auth.uid()
    and (p_owner is null or s.owner_id = p_owner)
    and (s.expires_at is null or s.expires_at > now() or s.fallback_events is not null);
$$;

revoke execute on function public.shared_calendars(uuid) from public, anon;
grant execute on function public.shared_calendars(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Sharing choices that follow you between devices
-- ---------------------------------------------------------------------------
-- Default levels, per-friend levels, picked event names, time-limited shares
-- and private events, in one row only you can read or write. Private events
-- are stored as salted SHA-256 hashes of their names, never the names.

create table if not exists public.sharing_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  settings jsonb not null check (jsonb_typeof(settings) = 'object' and pg_column_size(settings) < 50000),
  updated_at timestamptz not null default now()
);

alter table public.sharing_settings enable row level security;

drop policy if exists "Users read their own sharing settings" on public.sharing_settings;
create policy "Users read their own sharing settings"
  on public.sharing_settings for select to authenticated using (auth.uid() = user_id);

drop policy if exists "Users create their own sharing settings" on public.sharing_settings;
create policy "Users create their own sharing settings"
  on public.sharing_settings for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "Users update their own sharing settings" on public.sharing_settings;
create policy "Users update their own sharing settings"
  on public.sharing_settings for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Users delete their own sharing settings" on public.sharing_settings;
create policy "Users delete their own sharing settings"
  on public.sharing_settings for delete to authenticated using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- "Free now"
-- ---------------------------------------------------------------------------
-- A status you switch on for up to a day. Only accepted friends can see it.

create table if not exists public.presence (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  until timestamptz not null,
  note text not null default '' check (char_length(note) <= 80),
  updated_at timestamptz not null default now()
);

alter table public.presence enable row level security;
revoke all on public.presence from anon;

drop policy if exists "People manage their own status" on public.presence;
create policy "People manage their own status"
  on public.presence for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id and until <= now() + interval '1 day');

drop policy if exists "Friends see each other's status" on public.presence;
create policy "Friends see each other's status"
  on public.presence for select to authenticated
  using (
    exists (
      select 1 from public.friend_requests fr
      where fr.status = 'accepted'
        and ((fr.requester_id = auth.uid() and fr.recipient_id = user_id)
          or (fr.requester_id = user_id and fr.recipient_id = auth.uid()))
    )
  );

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

-- ---------------------------------------------------------------- booking links
--
-- One booking page per person. Visitors book through /api/book (service role),
-- never through these tables directly, so there is no public insert or select:
-- guests only ever see the open slots the API computes. Owners manage their own
-- page and see their own bookings through RLS.

create extension if not exists btree_gist with schema extensions;

create table if not exists public.booking_pages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users(id) on delete cascade,
  handle text not null unique check (handle ~ '^[a-z0-9][a-z0-9-]{2,47}$'),
  title text not null default 'Book a time' check (char_length(title) between 1 and 80),
  owner_name text not null default '' check (char_length(owner_name) <= 60),
  settings jsonb not null default '{}'::jsonb,
  -- Busy times published by the owner's app (start/end only, never titles).
  busy jsonb not null default '[]'::jsonb check (jsonb_typeof(busy) = 'array'),
  -- Calendar links the server reads to keep availability fresh while the app is closed.
  ics_urls text[] not null default '{}' check (cardinality(ics_urls) <= 3),
  busy_synced_at timestamptz,
  feed_token text not null unique default encode(extensions.gen_random_bytes(18), 'hex'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.booking_pages enable row level security;

drop policy if exists "Owners read their booking page" on public.booking_pages;
create policy "Owners read their booking page"
  on public.booking_pages for select to authenticated
  using (auth.uid() = owner_id);

drop policy if exists "Owners create their booking page" on public.booking_pages;
create policy "Owners create their booking page"
  on public.booking_pages for insert to authenticated
  with check (auth.uid() = owner_id);

drop policy if exists "Owners update their booking page" on public.booking_pages;
create policy "Owners update their booking page"
  on public.booking_pages for update to authenticated
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists "Owners delete their booking page" on public.booking_pages;
create policy "Owners delete their booking page"
  on public.booking_pages for delete to authenticated
  using (auth.uid() = owner_id);

-- Owners may not reassign a page or pick their own feed token.
revoke insert, update on public.booking_pages from authenticated;
grant insert (owner_id, handle, title, owner_name, settings, busy, ics_urls, busy_synced_at, active) on public.booking_pages to authenticated;
grant update (handle, title, owner_name, settings, busy, ics_urls, busy_synced_at, active, updated_at) on public.booking_pages to authenticated;

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references public.booking_pages(id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  guest_name text not null check (char_length(guest_name) between 1 and 80),
  guest_email text not null check (char_length(guest_email) between 3 and 254),
  note text not null default '' check (char_length(note) <= 500),
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  cancel_token text not null unique default encode(extensions.gen_random_bytes(18), 'hex'),
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  constraint bookings_positive_length check (end_at > start_at),
  -- Two confirmed bookings on one page can never overlap, even if two people
  -- press "Book" at the same moment.
  constraint bookings_no_overlap exclude using gist (page_id with =, tstzrange(start_at, end_at) with &&)
    where (status = 'confirmed')
);

create index if not exists bookings_page_start on public.bookings (page_id, start_at);

alter table public.bookings enable row level security;

drop policy if exists "Owners read their bookings" on public.bookings;
create policy "Owners read their bookings"
  on public.bookings for select to authenticated
  using (exists (select 1 from public.booking_pages p where p.id = page_id and p.owner_id = auth.uid()));

drop policy if exists "Owners cancel their bookings" on public.bookings;
create policy "Owners cancel their bookings"
  on public.bookings for update to authenticated
  using (exists (select 1 from public.booking_pages p where p.id = page_id and p.owner_id = auth.uid()))
  with check (status = 'cancelled');

revoke insert, update, delete on public.bookings from authenticated, anon;
grant update (status, cancelled_at) on public.bookings to authenticated;
revoke all on public.booking_pages, public.bookings from anon;

-- Google Calendar refresh tokens, sealed by api/google.js (AES-256-GCM).
-- Only the service role reads or writes them: RLS on, no policies.
create table if not exists public.google_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  refresh_token text not null check (char_length(refresh_token) < 4096),
  updated_at timestamptz not null default now()
);

alter table public.google_tokens enable row level security;
revoke all on public.google_tokens from anon, authenticated;
