-- Minimal local emulation of the parts of a fresh Supabase project that the
-- auth_profiles migration depends on: the `anon`/`authenticated`/`service_role`
-- roles, the `auth` schema with `auth.users`, `auth.uid()`/`auth.jwt()`, and
-- the default-privilege grants Supabase applies to new projects. This is a
-- throwaway stub for local verification only — it is never applied to a real
-- Supabase project (Supabase manages all of this itself there).

do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then
        create role anon nologin;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        create role authenticated nologin;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then
        create role service_role nologin;
    end if;
end $$;

create schema if not exists auth;

create table if not exists auth.users (
    id                 uuid primary key,
    email              text,
    phone              text,
    phone_confirmed_at timestamptz,
    aud                text,
    role               text,
    raw_app_meta_data  jsonb,
    raw_user_meta_data jsonb,
    created_at         timestamptz default now()
);

create or replace function auth.uid() returns uuid
language sql stable as $$
    select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;

create or replace function auth.jwt() returns jsonb
language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant execute on function auth.jwt() to anon, authenticated;

grant usage on schema public to anon, authenticated, service_role;

-- Supabase-style default privileges on the public schema, so the migration's
-- explicit revokes are exercised against realistic starting grants.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
