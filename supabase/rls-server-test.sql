-- Checks the tables the server writes: push subscriptions (each person sees
-- and changes only their own devices), the notification log (server only) and
-- the scheduler function (not callable by anyone signed in).
--
-- Paste into the Supabase SQL editor and run. Everything happens inside a
-- transaction that rolls back; the final SELECT is the report, and every row
-- should read passed = true.

begin;

create temp table rls_results(seq serial, check_name text, passed boolean, detail text) on commit drop;
grant all on rls_results to authenticated, anon;
grant all on sequence rls_results_seq_seq to authenticated, anon;

insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'alice@test.invalid', now(), now()),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'bob@test.invalid', now(), now());

insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
values ('22222222-2222-2222-2222-222222222222', 'https://push.test.invalid/bob', repeat('B', 87), repeat('b', 22));
insert into public.notification_log (key) values ('test:already-sent');

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","email":"alice@test.invalid","role":"authenticated"}';

do $$ begin
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ('11111111-1111-1111-1111-111111111111', 'https://push.test.invalid/alice', repeat('A', 87), repeat('a', 22));
  insert into rls_results(check_name, passed, detail) values ('you can add your own device', true, 'inserted');
exception when others then
  insert into rls_results(check_name, passed, detail) values ('you can add your own device', false, sqlerrm);
end $$;

do $$ begin
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ('22222222-2222-2222-2222-222222222222', 'https://push.test.invalid/forged', repeat('A', 87), repeat('a', 22));
  insert into rls_results(check_name, passed, detail) values ('cannot add a device to someone else''s account', false, 'the insert was allowed');
exception when others then
  insert into rls_results(check_name, passed, detail) values ('cannot add a device to someone else''s account', true, sqlerrm);
end $$;

do $$ begin
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ('11111111-1111-1111-1111-111111111111', 'http://insecure.test.invalid/x', repeat('A', 87), repeat('a', 22));
  insert into rls_results(check_name, passed, detail) values ('only https push endpoints', false, 'the insert was allowed');
exception when others then
  insert into rls_results(check_name, passed, detail) values ('only https push endpoints', true, sqlerrm);
end $$;

insert into rls_results(check_name, passed, detail)
select 'you see only your own devices', count(*) = 1 and bool_and(user_id = '11111111-1111-1111-1111-111111111111'), 'rows: ' || count(*) from public.push_subscriptions;
with attempt as (update public.push_subscriptions set weekly_nudge = true where endpoint = 'https://push.test.invalid/bob' returning 1)
insert into rls_results(check_name, passed, detail) select 'cannot change someone else''s device', count(*) = 0, 'updated: ' || count(*) from attempt;
with attempt as (delete from public.push_subscriptions where endpoint = 'https://push.test.invalid/bob' returning 1)
insert into rls_results(check_name, passed, detail) select 'cannot remove someone else''s device', count(*) = 0, 'deleted: ' || count(*) from attempt;
with attempt as (update public.push_subscriptions set weekly_nudge = true where endpoint = 'https://push.test.invalid/alice' returning 1)
insert into rls_results(check_name, passed, detail) select 'you can change your own device', count(*) = 1, 'updated: ' || count(*) from attempt;

do $$ begin
  perform count(*) from public.notification_log;
  insert into rls_results(check_name, passed, detail) values ('the notification log is server only', false, 'read was allowed');
exception when others then
  insert into rls_results(check_name, passed, detail) values ('the notification log is server only', true, sqlerrm);
end $$;

do $$ begin
  perform public.call_waddle_cron('reminders');
  insert into rls_results(check_name, passed, detail) values ('signed-in people cannot trigger the scheduler', false, 'the call was allowed');
exception when others then
  insert into rls_results(check_name, passed, detail) values ('signed-in people cannot trigger the scheduler', true, sqlerrm);
end $$;

reset role;
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';
do $$ begin
  perform count(*) from public.push_subscriptions;
  insert into rls_results(check_name, passed, detail) values ('signed-out visitors cannot read devices', false, 'read was allowed');
exception when others then
  insert into rls_results(check_name, passed, detail) values ('signed-out visitors cannot read devices', true, sqlerrm);
end $$;

reset role;
select check_name, passed, detail from rls_results order by seq;

rollback;
