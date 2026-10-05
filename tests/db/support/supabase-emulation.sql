-- TEST ONLY. Emulates the parts of a Supabase project the database foundation relies on, so the same
-- migrations, provisioning and isolation suite run against a local, disposable PostgreSQL 17 cluster.
-- Executed by the cluster superuser (named `supabase_admin`, as on Supabase) in the test database.
-- Mirrors the managed facts recorded in the pre-implementation validation (§23):
--   · `postgres` is NOT a superuser but has CREATEROLE and BYPASSRLS (F-S1) and administers `authenticated`;
--   · `authenticated` / `anon` are NOLOGIN NOBYPASSRLS; `service_role` bypasses RLS;
--   · auth.uid() has Supabase's real definition and `auth` is not usable by custom owner roles (F-S2).

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator nologin noinherit;
grant anon, authenticated, service_role to authenticator;
grant anon, authenticated, service_role to postgres with admin option;

revoke all on schema public from public;
grant usage on schema public to postgres, anon, authenticated, service_role;

create schema auth;
create function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
revoke all on function auth.uid() from public;
grant usage on schema auth to postgres, anon, authenticated, service_role;
grant execute on function auth.uid() to postgres, anon, authenticated, service_role;
