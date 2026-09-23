-- Checks that the calendar_shares policies in schema.sql actually hold.
--
-- Paste into the Supabase SQL editor and run. Everything happens inside a
-- transaction that rolls back, so it leaves nothing behind — the final SELECT
-- is the report, and every row should read passed = true.

begin;

create temp table rls_results(seq serial, check_name text, passed boolean, detail text) on commit drop;
grant all on rls_results to authenticated;
grant all on sequence rls_results_seq_seq to authenticated;

-- Alice and Bob are friends. Carol is friends with nobody.
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'alice@test.invalid', now(), now()),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'bob@test.invalid', now(), now()),
  ('33333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol@test.invalid', now(), now());

insert into public.friend_requests (id, requester_id, recipient_email, recipient_id, status)
values ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'bob@test.invalid', '22222222-2222-2222-2222-222222222222', 'accepted');

set local role authenticated;

-- Alice shares with Bob.
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","email":"alice@test.invalid","role":"authenticated"}';
do $$ begin
  insert into public.calendar_shares (owner_id, viewer_id, events)
  values ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '[{"start":"2026-09-24T13:00:00Z","end":"2026-09-24T14:00:00Z","title":"Soccer"}]');
  insert into rls_results(check_name, passed, detail) values ('an owner can share with a friend', true, 'inserted');
exception when others then
  insert into rls_results(check_name, passed, detail) values ('an owner can share with a friend', false, sqlerrm);
end $$;

do $$ begin
  insert into public.calendar_shares (owner_id, viewer_id) values ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333');
  insert into rls_results(check_name, passed, detail) values ('cannot share with somebody who is not a friend', false, 'the insert was allowed');
exception when others then
  insert into rls_results(check_name, passed, detail) values ('cannot share with somebody who is not a friend', true, sqlerrm);
end $$;

do $$ begin
  insert into public.calendar_shares (owner_id, viewer_id) values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111');
  insert into rls_results(check_name, passed, detail) values ('cannot write a share as somebody else', false, 'the insert was allowed');
exception when others then
  insert into rls_results(check_name, passed, detail) values ('cannot write a share as somebody else', true, sqlerrm);
end $$;

do $$ begin
  insert into public.calendar_shares (owner_id, viewer_id, events) values ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '{"not":"a list"}')
  on conflict (owner_id, viewer_id) do update set events = excluded.events;
  insert into rls_results(check_name, passed, detail) values ('events must be a list', false, 'the write was allowed');
exception when others then
  insert into rls_results(check_name, passed, detail) values ('events must be a list', true, sqlerrm);
end $$;

with attempt as (update public.calendar_shares set events = '[]' where owner_id = '11111111-1111-1111-1111-111111111111' returning 1)
insert into rls_results(check_name, passed, detail) select 'an owner can update their share', count(*) = 1, 'updated: ' || count(*) from attempt;

-- Bob: the viewer.
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","email":"bob@test.invalid","role":"authenticated"}';
insert into rls_results(check_name, passed, detail)
select 'the friend reads what was shared with them', count(*) = 1, 'rows: ' || count(*) from public.calendar_shares where owner_id = '11111111-1111-1111-1111-111111111111';
with attempt as (update public.calendar_shares set events = '[{"start":"2026-09-24T13:00:00Z","end":"2026-09-24T14:00:00Z","title":"Forged"}]' returning 1)
insert into rls_results(check_name, passed, detail) select 'the viewer cannot rewrite the owner''s share', count(*) = 0, 'updated: ' || count(*) from attempt;

-- Carol: unrelated.
set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","email":"carol@test.invalid","role":"authenticated"}';
insert into rls_results(check_name, passed, detail)
select 'an unrelated account reads nothing', count(*) = 0, 'rows: ' || count(*) from public.calendar_shares;
with attempt as (delete from public.calendar_shares returning 1)
insert into rls_results(check_name, passed, detail) select 'an unrelated account cannot delete a share', count(*) = 0, 'deleted: ' || count(*) from attempt;

-- Ending the friendship removes the share.
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","email":"alice@test.invalid","role":"authenticated"}';
delete from public.friend_requests where id = 'aaaaaaaa-0000-0000-0000-000000000001';
insert into rls_results(check_name, passed, detail)
select 'unfriending removes the share', count(*) = 0, 'rows left: ' || count(*) from public.calendar_shares;

reset role;
select check_name, passed, detail from rls_results order by seq;

rollback;
