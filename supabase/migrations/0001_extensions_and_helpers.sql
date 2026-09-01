-- 0001 Extensions and shared helpers
--
-- Implements the shared plumbing every other migration depends on.
-- Spec: docs/03-architecture.md, "Data model" (all tables have id, created_at, updated_at).
--
-- Ownership note that applies to the whole schema:
-- Every table that carries user_id holds either an auth.users id (a signed in
-- person) or a judge_sessions id (docs/07-payments-and-judge-mode.md, "Data
-- written during a judge session is owned by the session id"). Because those two
-- id spaces live in different tables, user_id carries no foreign key. Only
-- public.profiles.user_id references auth.users, because a profile always
-- belongs to a signed in person. Judge owned rows are removed by
-- public.purge_expired_judge_data() in migration 0007.

create extension if not exists "pgcrypto" with schema extensions;

-- Keeps updated_at honest without asking every writer to remember it.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'Trigger function: sets updated_at to now() on every UPDATE. Attached to every table in the public schema.';
