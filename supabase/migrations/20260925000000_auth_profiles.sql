-- Profiles, approval workflow and one-device sessions for Funnel auth.
create type public.user_status as enum ('pending', 'approved', 'rejected');
create type public.user_role as enum ('user', 'admin');

create table public.profiles (
    id                 uuid primary key references auth.users(id) on delete cascade,
    full_name          text not null default '',
    email              text not null default '',
    phone              text unique,
    signup_provider    text not null default 'email',
    status             public.user_status not null default 'pending',
    role               public.user_role not null default 'user',
    current_session_id uuid,
    created_at         timestamptz not null default now(),
    approved_at        timestamptz,
    approved_by        uuid references auth.users(id) on delete set null
);
create index profiles_status_created_idx on public.profiles (status, created_at desc);

create table public.admin_audit_log (
    id         bigserial primary key,
    admin_id   uuid references auth.users(id) on delete set null,
    target_id  uuid references auth.users(id) on delete set null,
    action     text not null check (action in ('approve', 'reject', 'make_admin', 'revoke_admin')),
    created_at timestamptz not null default now()
);

-- RLS: users read their own profile and may only change their name.
alter table public.profiles enable row level security;
alter table public.admin_audit_log enable row level security;

create policy "profiles: read own" on public.profiles
    for select to authenticated using (id = auth.uid());
create policy "profiles: update own" on public.profiles
    for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (full_name) on public.profiles to authenticated;
revoke all on public.admin_audit_log from anon, authenticated;
revoke all on sequence public.admin_audit_log_id_seq from anon, authenticated;

-- Server-side access (service_role key via PostgREST): explicit, not reliant on default privileges.
grant select, update on public.profiles to service_role;
grant select, insert on public.admin_audit_log to service_role;
grant usage on sequence public.admin_audit_log_id_seq to service_role;

-- New auth user → pending profile.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    insert into public.profiles (id, full_name, email, signup_provider, phone)
    values (
        new.id,
        coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', ''),
        coalesce(new.email, ''),
        coalesce(new.raw_app_meta_data ->> 'provider', 'email'),
        case
            when new.phone_confirmed_at is not null and coalesce(new.phone, '') <> ''
                then '+' || ltrim(new.phone, '+')
            else null
        end
    );
    return new;
end $$;

create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- Keep profile email/phone in sync with verified auth values (phone stored as E.164 with '+').
create function public.sync_profile_contact() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
    update public.profiles set
        email = coalesce(new.email, ''),
        phone = case
            when new.phone_confirmed_at is not null and coalesce(new.phone, '') <> ''
                then '+' || ltrim(new.phone, '+')
            else null
        end
    where id = new.id;
    return new;
end $$;

create trigger on_auth_user_contact_changed
    after update of email, phone, phone_confirmed_at on auth.users
    for each row execute function public.sync_profile_contact();

revoke execute on function public.sync_profile_contact() from public, anon, authenticated;

-- Called by the client right after sign-in: this session now owns the account.
create function public.claim_session() returns void
language plpgsql security definer set search_path = '' as $$
declare
    sid uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
begin
    if auth.uid() is null or sid is null then
        raise exception 'not authenticated' using errcode = '28000';
    end if;
    -- A displaced device's JWT stays valid until expiry; only a live session may claim.
    if not exists (select 1 from auth.sessions s where s.id = sid and s.user_id = auth.uid()) then
        raise exception 'session is not active' using errcode = '28000';
    end if;
    update public.profiles set current_session_id = sid where id = auth.uid();
end $$;

revoke execute on function public.claim_session() from public, anon;
grant execute on function public.claim_session() to authenticated;
