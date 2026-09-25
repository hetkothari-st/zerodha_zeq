begin;

-- User 1: created with unverified contact info.
insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values ('00000000-0000-4000-8000-000000000001', 'check@example.com', 'authenticated', 'authenticated',
        '{"provider":"google"}', '{"full_name":"Check User"}');

do $$
declare p public.profiles;
begin
    select * into p from public.profiles where id = '00000000-0000-4000-8000-000000000001';
    if not found then
        raise exception 'FAIL: profile row not created for user 1';
    end if;
    if p.status is distinct from 'pending'
        or p.full_name is distinct from 'Check User'
        or p.signup_provider is distinct from 'google'
        or p.email is distinct from 'check@example.com' then
        raise exception 'FAIL: profile not created as expected: %', row_to_json(p);
    end if;
    raise notice 'ok: profile auto-created as pending';
end $$;

update auth.users set phone = '919876543210', phone_confirmed_at = now() where id = '00000000-0000-4000-8000-000000000001';
do $$
declare v_phone text;
begin
    select phone into v_phone from public.profiles where id = '00000000-0000-4000-8000-000000000001';
    if not found then
        raise exception 'FAIL: profile row missing for user 1 when checking phone sync';
    end if;
    if v_phone is distinct from '+919876543210' then
        raise exception 'FAIL: verified phone not synced (got %)', v_phone;
    end if;
    raise notice 'ok: verified phone synced as E.164';
end $$;

-- User 2: created with an already-verified phone at insert time.
insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, phone, phone_confirmed_at)
values ('00000000-0000-4000-8000-000000000002', 'check2@example.com', 'authenticated', 'authenticated',
        '{"provider":"email"}', '{"full_name":"Second User"}', '919999999999', now());

do $$
declare v_phone text;
begin
    select phone into v_phone from public.profiles where id = '00000000-0000-4000-8000-000000000002';
    if not found then
        raise exception 'FAIL: profile row not created for user 2';
    end if;
    if v_phone is distinct from '+919999999999' then
        raise exception 'FAIL: phone not set at insert for a pre-verified number (got %)', v_phone;
    end if;
    raise notice 'ok: phone set correctly at insert time for pre-verified number';
end $$;

-- Live auth sessions: user 1 owns ...aa, user 2 owns ...cc.
insert into auth.sessions (id, user_id) values
    ('00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-000000000001'),
    ('00000000-0000-4000-8000-0000000000cc', '00000000-0000-4000-8000-000000000002');

-- The servers' service_role key needs exactly these privileges.
do $$ begin
    if not (has_table_privilege('service_role', 'public.profiles', 'select')
        and has_table_privilege('service_role', 'public.profiles', 'update')
        and has_table_privilege('service_role', 'public.admin_audit_log', 'select')
        and has_table_privilege('service_role', 'public.admin_audit_log', 'insert')
        and has_sequence_privilege('service_role', 'public.admin_audit_log_id_seq', 'usage')) then
        raise exception 'FAIL: service_role is missing profile/audit-log privileges';
    end if;
    raise notice 'ok: service_role has select/update on profiles, select/insert on audit log, sequence usage';
end $$;

set local role authenticated;
select set_config('request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000000001","session_id":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}', true);

select public.claim_session();
do $$
declare v_sid uuid;
begin
    select current_session_id into v_sid from public.profiles where id = auth.uid();
    if not found then
        raise exception 'FAIL: profile row missing for auth.uid() after claim_session';
    end if;
    if v_sid is distinct from '00000000-0000-4000-8000-0000000000aa'::uuid then
        raise exception 'FAIL: claim_session did not record the session (got %)', v_sid;
    end if;
    raise notice 'ok: claim_session records current session';
end $$;

update public.profiles set full_name = 'Renamed' where id = auth.uid();
do $$
declare v_name text;
begin
    select full_name into v_name from public.profiles where id = auth.uid();
    if not found or v_name is distinct from 'Renamed' then
        raise exception 'FAIL: full_name update by owner did not take effect (got %)', v_name;
    end if;
    raise notice 'ok: full_name update by owner took effect';
end $$;

do $$ begin
    begin
        update public.profiles set status = 'approved' where id = auth.uid();
        raise exception 'FAIL: user could change own status';
    exception when insufficient_privilege then
        raise notice 'ok: status change blocked for users';
    end;
    begin
        update public.profiles set role = 'admin' where id = auth.uid();
        raise exception 'FAIL: user could make themselves admin';
    exception when insufficient_privilege then
        raise notice 'ok: role change blocked for users';
    end;
    begin
        perform * from public.admin_audit_log;
        raise exception 'FAIL: user could read the audit log';
    exception when insufficient_privilege then
        raise notice 'ok: audit log hidden from users';
    end;
end $$;

-- Row-level security: user 1 must not see user 2's profile at all.
do $$
declare cnt int;
begin
    select count(*) into cnt from public.profiles where id = '00000000-0000-4000-8000-000000000002';
    if cnt <> 0 then
        raise exception 'FAIL: authenticated user could see another user''s profile (count=%)', cnt;
    end if;
    raise notice 'ok: authenticated user cannot see another user''s profile';
end $$;

do $$ begin
    begin
        insert into public.profiles (id, full_name, email)
        values ('00000000-0000-4000-8000-000000000099', 'Intruder', 'intruder@example.com');
        raise exception 'FAIL: authenticated user could insert into profiles';
    exception when insufficient_privilege then
        raise notice 'ok: insert into profiles blocked for users';
    end;
    begin
        delete from public.profiles where id = auth.uid();
        raise exception 'FAIL: authenticated user could delete their own profile';
    exception when insufficient_privilege then
        raise notice 'ok: delete from profiles blocked for users';
    end;
    begin
        update public.profiles set phone = '+10000000000' where id = auth.uid();
        raise exception 'FAIL: authenticated user could update phone directly';
    exception when insufficient_privilege then
        raise notice 'ok: phone column update blocked for users';
    end;
    begin
        update public.profiles set current_session_id = '00000000-0000-4000-8000-0000000000bb' where id = auth.uid();
        raise exception 'FAIL: authenticated user could update current_session_id directly';
    exception when insufficient_privilege then
        raise notice 'ok: current_session_id column update blocked for users';
    end;
end $$;

-- claim_session() must reject claims that carry no session_id.
do $$ begin
    begin
        perform set_config('request.jwt.claims',
            '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
        perform public.claim_session();
        raise exception 'FAIL: claim_session succeeded without a session_id claim';
    exception when sqlstate '28000' then
        raise notice 'ok: claim_session rejects claims without session_id';
    end;
end $$;

-- claim_session() must reject a session that is not a live auth session of this user
-- (e.g. a displaced device's still-valid JWT after its session row was removed).
do $$ begin
    begin
        perform set_config('request.jwt.claims',
            '{"sub":"00000000-0000-4000-8000-000000000001","session_id":"00000000-0000-4000-8000-0000000000dd","role":"authenticated"}', true);
        perform public.claim_session();
        raise exception 'FAIL: claim_session accepted a session_id not present in auth.sessions';
    exception when sqlstate '28000' then
        raise notice 'ok: claim_session rejects a session_id not present in auth.sessions';
    end;
    begin
        perform set_config('request.jwt.claims',
            '{"sub":"00000000-0000-4000-8000-000000000001","session_id":"00000000-0000-4000-8000-0000000000cc","role":"authenticated"}', true);
        perform public.claim_session();
        raise exception 'FAIL: claim_session accepted another user''s session';
    exception when sqlstate '28000' then
        raise notice 'ok: claim_session rejects another user''s session';
    end;
end $$;
do $$
declare v_sid uuid;
begin
    select current_session_id into v_sid from public.profiles where id = '00000000-0000-4000-8000-000000000001';
    if v_sid is distinct from '00000000-0000-4000-8000-0000000000aa'::uuid then
        raise exception 'FAIL: rejected claim_session changed current_session_id (got %)', v_sid;
    end if;
    raise notice 'ok: rejected claims leave current_session_id unchanged';
end $$;

-- anon must not be able to read profiles or claim a session at all.
set local role anon;
do $$ begin
    begin
        perform * from public.profiles limit 1;
        raise exception 'FAIL: anon could select from profiles';
    exception when insufficient_privilege then
        raise notice 'ok: anon cannot select profiles';
    end;
    begin
        perform public.claim_session();
        raise exception 'FAIL: anon could execute claim_session';
    exception when insufficient_privilege then
        raise notice 'ok: anon cannot execute claim_session';
    end;
end $$;

rollback;
