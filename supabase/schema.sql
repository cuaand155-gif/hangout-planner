create table if not exists public.workspaces (
  slug text primary key,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.workspaces (slug, state)
values (
  'weekend-crew',
  '{
    "privacy": "busy",
    "members": [
      {"name":"Jamie Miller","initials":"JM","status":"All set","updated":"12m ago"},
      {"name":"Taylor Kim","initials":"TK","status":"All set","updated":"1h ago"},
      {"name":"Riley Lee","initials":"RL","status":"Needs update","updated":"yesterday"}
    ],
    "ideas": [
      {"title":"Slow morning brunch","description":"Good coffee, no rush, extra syrup.","votes":4},
      {"title":"Picnic in the park","description":"Fresh air and a blanket in the sun.","votes":2},
      {"title":"Games night","description":"Bring your best strategy and snacks.","votes":3}
    ]
  }'::jsonb
)
on conflict (slug) do nothing;

alter table public.workspaces enable row level security;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  photo_url text,
  share_schedule boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  addressee_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'blocked')),
  created_at timestamptz not null default now(),
  unique (requester_id, addressee_id)
);

create table if not exists public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null check (provider in ('google', 'icloud')),
  external_account text,
  connected_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.friendships enable row level security;
alter table public.calendar_connections enable row level security;
