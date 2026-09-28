-- Free/Pro billing: Razorpay subscriptions, complimentary Pro, entitlement().

alter table public.profiles add column comp_pro boolean not null default false;

create table public.subscriptions (
    id                       bigserial primary key,
    user_id                  uuid not null references public.profiles(id) on delete cascade,
    razorpay_subscription_id text not null unique,
    status                   text not null,
    current_end              timestamptz,
    cancel_at_period_end     boolean not null default false,
    short_url                text,
    last_event_at            timestamptz,
    created_at               timestamptz not null default now(),
    updated_at               timestamptz not null default now()
);
create index subscriptions_user_created_idx on public.subscriptions (user_id, created_at desc);
-- At most one open (non-terminal) subscription per user: stops double charges.
create unique index subscriptions_one_open_per_user on public.subscriptions (user_id)
    where status in ('created', 'authenticated', 'active', 'pending');

-- Razorpay event ids already processed (webhook idempotency).
create table public.billing_events (
    event_id    text primary key,
    received_at timestamptz not null default now()
);

alter table public.subscriptions enable row level security;
alter table public.billing_events enable row level security;

create policy "subscriptions: read own" on public.subscriptions
    for select to authenticated using (user_id = auth.uid());

revoke all on public.subscriptions from anon, authenticated;
grant select on public.subscriptions to authenticated;
revoke all on public.billing_events from anon, authenticated;
revoke all on sequence public.subscriptions_id_seq from anon, authenticated;

grant select, insert, update on public.subscriptions to service_role;
grant usage on sequence public.subscriptions_id_seq to service_role;
grant select, insert, delete on public.billing_events to service_role;

alter table public.admin_audit_log drop constraint admin_audit_log_action_check;
alter table public.admin_audit_log add constraint admin_audit_log_action_check
    check (action in ('approve', 'reject', 'make_admin', 'revoke_admin', 'grant_comp', 'revoke_comp'));

-- pro when: admin, complimentary, or a paid period that hasn't ended.
-- active/authenticated/pending get a 3-day grace (late renewal webhook or retrying a failed charge);
-- cancelled keeps access exactly to the end of the paid period.
create function public.entitlement(uid uuid)
returns table (plan text, source text, until timestamptz)
language sql stable security definer set search_path = '' as $$
    with p as (
        select role::text as role, comp_pro from public.profiles where id = uid
    ), s as (
        select current_end from public.subscriptions
        where user_id = uid and current_end is not null and (
            (status in ('authenticated', 'active', 'pending') and current_end + interval '3 days' > now())
            or (status = 'cancelled' and current_end > now())
        )
        order by current_end desc
        limit 1
    )
    select
        case when (select role from p) = 'admin' or coalesce((select comp_pro from p), false) or exists (select 1 from s)
             then 'pro' else 'free' end,
        case when (select role from p) = 'admin' then 'admin'
             when coalesce((select comp_pro from p), false) then 'comp'
             when exists (select 1 from s) then 'subscription'
             else null end,
        case when (select role from p) = 'admin' or coalesce((select comp_pro from p), false) then null
             else (select current_end from s) end;
$$;

revoke execute on function public.entitlement(uuid) from public, anon, authenticated;
grant execute on function public.entitlement(uuid) to service_role;
