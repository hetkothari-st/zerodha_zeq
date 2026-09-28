begin;

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data) values
    ('00000000-0000-4000-8000-0000000000a1', 'free@example.com',   'authenticated', 'authenticated', '{"provider":"email"}', '{}'),
    ('00000000-0000-4000-8000-0000000000a2', 'admin@example.com',  'authenticated', 'authenticated', '{"provider":"email"}', '{}'),
    ('00000000-0000-4000-8000-0000000000a3', 'comp@example.com',   'authenticated', 'authenticated', '{"provider":"email"}', '{}'),
    ('00000000-0000-4000-8000-0000000000a4', 'active@example.com', 'authenticated', 'authenticated', '{"provider":"email"}', '{}'),
    ('00000000-0000-4000-8000-0000000000a5', 'grace@example.com',  'authenticated', 'authenticated', '{"provider":"email"}', '{}'),
    ('00000000-0000-4000-8000-0000000000a6', 'lapsed@example.com', 'authenticated', 'authenticated', '{"provider":"email"}', '{}'),
    ('00000000-0000-4000-8000-0000000000a7', 'cxl-in@example.com', 'authenticated', 'authenticated', '{"provider":"email"}', '{}'),
    ('00000000-0000-4000-8000-0000000000a8', 'cxl-out@example.com','authenticated', 'authenticated', '{"provider":"email"}', '{}'),
    ('00000000-0000-4000-8000-0000000000a9', 'halted@example.com', 'authenticated', 'authenticated', '{"provider":"email"}', '{}');

update public.profiles set role = 'admin' where id = '00000000-0000-4000-8000-0000000000a2';
update public.profiles set comp_pro = true where id = '00000000-0000-4000-8000-0000000000a3';

insert into public.subscriptions (user_id, razorpay_subscription_id, status, current_end) values
    ('00000000-0000-4000-8000-0000000000a4', 'sub_active', 'active',    now() + interval '20 days'),
    ('00000000-0000-4000-8000-0000000000a5', 'sub_grace',  'pending',   now() - interval '1 day'),
    ('00000000-0000-4000-8000-0000000000a6', 'sub_lapsed', 'pending',   now() - interval '4 days'),
    ('00000000-0000-4000-8000-0000000000a7', 'sub_cxl_in', 'cancelled', now() + interval '5 days'),
    ('00000000-0000-4000-8000-0000000000a8', 'sub_cxl_out','cancelled', now() - interval '1 hour'),
    ('00000000-0000-4000-8000-0000000000a9', 'sub_halted', 'halted',    now() + interval '5 days');

do $$
declare
    expected text[][] := array[
        ['00000000-0000-4000-8000-0000000000a1', 'free', ''],
        ['00000000-0000-4000-8000-0000000000a2', 'pro',  'admin'],
        ['00000000-0000-4000-8000-0000000000a3', 'pro',  'comp'],
        ['00000000-0000-4000-8000-0000000000a4', 'pro',  'subscription'],
        ['00000000-0000-4000-8000-0000000000a5', 'pro',  'subscription'],
        ['00000000-0000-4000-8000-0000000000a6', 'free', ''],
        ['00000000-0000-4000-8000-0000000000a7', 'pro',  'subscription'],
        ['00000000-0000-4000-8000-0000000000a8', 'free', ''],
        ['00000000-0000-4000-8000-0000000000a9', 'free', '']
    ];
    r record;
    i int;
begin
    for i in 1 .. array_length(expected, 1) loop
        select * into r from public.entitlement(expected[i][1]::uuid);
        if r.plan is distinct from expected[i][2] or coalesce(r.source, '') is distinct from expected[i][3] then
            raise exception 'FAIL: entitlement(%) = (%, %), expected (%, %)', expected[i][1], r.plan, r.source, expected[i][2], expected[i][3];
        end if;
    end loop;
    raise notice 'ok: entitlement covers admin, comp, active, grace, lapsed, cancelled in/out of period, halted, none';
end $$;

-- One open subscription per user.
do $$
begin
    begin
        insert into public.subscriptions (user_id, razorpay_subscription_id, status)
        values ('00000000-0000-4000-8000-0000000000a4', 'sub_dupe', 'created');
        raise exception 'FAIL: second open subscription was allowed';
    exception when unique_violation then
        raise notice 'ok: second open subscription rejected';
    end;
end $$;

-- A new subscription is allowed once the old one is terminal.
insert into public.subscriptions (user_id, razorpay_subscription_id, status)
values ('00000000-0000-4000-8000-0000000000a9', 'sub_after_halt', 'created');

-- Audit log accepts the comp actions.
insert into public.admin_audit_log (admin_id, target_id, action)
values ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000a3', 'grant_comp');

-- Clients can't call entitlement() or read billing_events directly.
do $$
begin
    if has_function_privilege('authenticated', 'public.entitlement(uuid)', 'execute') then
        raise exception 'FAIL: authenticated can execute entitlement()';
    end if;
    if has_table_privilege('authenticated', 'public.billing_events', 'select') then
        raise exception 'FAIL: authenticated can read billing_events';
    end if;
    if has_table_privilege('authenticated', 'public.subscriptions', 'insert') then
        raise exception 'FAIL: authenticated can insert subscriptions';
    end if;
    if has_table_privilege('authenticated', 'public.subscriptions', 'update') then
        raise exception 'FAIL: authenticated can update subscriptions';
    end if;
    if has_column_privilege('authenticated', 'public.profiles', 'comp_pro', 'update') then
        raise exception 'FAIL: authenticated can update profiles.comp_pro';
    end if;
    raise notice 'ok: billing privileges locked down';
end $$;

rollback;
