-- Checks that the friend_requests policies in schema.sql actually hold.
--
-- Paste into the Supabase SQL editor and run. Everything happens inside a
-- transaction that rolls back, so it creates no accounts and no requests —
-- the final SELECT is the report, and every row should read passed = true.
--
-- Run it after any change to the policies or grants on friend_requests.

begin;

create temp table rls_results(seq serial, check_name text, passed boolean, detail text) on commit drop;
grant all on rls_results to authenticated;
grant all on sequence rls_results_seq_seq to authenticated;

-- Three throwaway accounts: Alice sends, Bob receives, Carol is unrelated.
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'alice@test.invalid', now(), now()),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'bob@test.invalid', now(), now()),
  ('33333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol@test.invalid', now(), now());

insert into public.friend_requests (id, requester_id, recipient_email, status)
values ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'bob@test.invalid', 'pending');

set local role authenticated;

-- Bob: addressed by email, recipient_id still null.
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","email":"bob@test.invalid","role":"authenticated"}';
insert into rls_results(check_name, passed, detail)
select 'recipient reads a request addressed to their email', count(*) = 1, 'rows: ' || count(*) from public.friend_requests;

-- Carol: nothing to do with this request.
set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","email":"carol@test.invalid","role":"authenticated"}';
insert into rls_results(check_name, passed, detail)
select 'an unrelated account cannot read it', count(*) = 0, 'rows: ' || count(*) from public.friend_requests;
with attempt as (update public.friend_requests set status = 'accepted', recipient_id = '33333333-3333-3333-3333-333333333333' returning 1)
insert into rls_results(check_name, passed, detail) select 'an unrelated account cannot answer it', count(*) = 0, 'updated: ' || count(*) from attempt;

-- Alice: the sender.
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","email":"alice@test.invalid","role":"authenticated"}';
insert into rls_results(check_name, passed, detail)
select 'the sender reads their own request', count(*) = 1, 'rows: ' || count(*) from public.friend_requests;
with attempt as (update public.friend_requests set status = 'accepted', recipient_id = '11111111-1111-1111-1111-111111111111' where id = 'aaaaaaaa-0000-0000-0000-000000000001' returning 1)
insert into rls_results(check_name, passed, detail) select 'the sender cannot accept their own request', count(*) = 0, 'updated: ' || count(*) from attempt;

-- Inserts that violate a policy raise, so each one gets its own savepoint.
do $$ begin
  insert into public.friend_requests (requester_id, recipient_email) values ('22222222-2222-2222-2222-222222222222', 'carol@test.invalid');
  insert into rls_results(check_name, passed, detail) values ('cannot send a request as somebody else', false, 'the insert was allowed');
exception when others then
  insert into rls_results(check_name, passed, detail) values ('cannot send a request as somebody else', true, sqlerrm);
end $$;

do $$ begin
  insert into public.friend_requests (requester_id, recipient_email) values ('11111111-1111-1111-1111-111111111111', 'ALICE@test.invalid');
  insert into rls_results(check_name, passed, detail) values ('cannot send a request to yourself', false, 'the insert was allowed');
exception when others then
  insert into rls_results(check_name, passed, detail) values ('cannot send a request to yourself', true, sqlerrm);
end $$;

do $$ begin
  insert into public.friend_requests (requester_id, recipient_email, recipient_id)
  values ('11111111-1111-1111-1111-111111111111', 'someone@test.invalid', '33333333-3333-3333-3333-333333333333');
  insert into rls_results(check_name, passed, detail) values ('cannot drop a request into another account''s inbox', false, 'the insert was allowed');
exception when others then
  insert into rls_results(check_name, passed, detail) values ('cannot drop a request into another account''s inbox', true, sqlerrm);
end $$;

do $$ begin
  insert into public.friend_requests (requester_id, recipient_email) values ('11111111-1111-1111-1111-111111111111', 'BOB@test.invalid');
  insert into rls_results(check_name, passed, detail) values ('cannot stack a duplicate live request', false, 'the insert was allowed');
exception when others then
  insert into rls_results(check_name, passed, detail) values ('cannot stack a duplicate live request', true, sqlerrm);
end $$;

-- Bob answers, then tries to restate who the request came from.
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","email":"bob@test.invalid","role":"authenticated"}';
with attempt as (update public.friend_requests set status = 'accepted', recipient_id = '22222222-2222-2222-2222-222222222222', responded_at = now() where id = 'aaaaaaaa-0000-0000-0000-000000000001' returning 1)
insert into rls_results(check_name, passed, detail) select 'the recipient can accept', count(*) = 1, 'updated: ' || count(*) from attempt;

do $$ begin
  update public.friend_requests set requester_id = '33333333-3333-3333-3333-333333333333' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  insert into rls_results(check_name, passed, detail) values ('the recipient cannot rewrite who it came from', false, 'the update was allowed');
exception when others then
  insert into rls_results(check_name, passed, detail) values ('the recipient cannot rewrite who it came from', true, sqlerrm);
end $$;

do $$ begin
  update public.friend_requests set recipient_email = 'carol@test.invalid' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  insert into rls_results(check_name, passed, detail) values ('the recipient cannot rewrite who it was for', false, 'the update was allowed');
exception when others then
  insert into rls_results(check_name, passed, detail) values ('the recipient cannot rewrite who it was for', true, sqlerrm);
end $$;

-- The accepted friendship stays between its two people.
set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","email":"carol@test.invalid","role":"authenticated"}';
insert into rls_results(check_name, passed, detail)
select 'an accepted friendship stays private to its two people', count(*) = 0, 'rows: ' || count(*) from public.friend_requests;

set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","email":"alice@test.invalid","role":"authenticated"}';
with attempt as (delete from public.friend_requests where id = 'aaaaaaaa-0000-0000-0000-000000000001' returning 1)
insert into rls_results(check_name, passed, detail) select 'the sender can withdraw', count(*) = 1, 'deleted: ' || count(*) from attempt;

reset role;
select check_name, passed, detail from rls_results order by seq;

rollback;
