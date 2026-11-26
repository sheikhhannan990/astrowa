-- Phase 1 lockdown: only logged-in staff can read the inbox.
--
-- Run this ONLY after the new inbox is live and you have logged in with
-- your admin account. Until now, anyone with the Netlify link could read
-- every chat through the public (anon) key; after this, they can't.
-- Safe to re-run.

do $$
declare
  t text;
  p record;
begin
  foreach t in array array['conversations', 'messages', 'customers', 'message_status_events'] loop
    execute format('alter table public.%I enable row level security', t);
    -- Remove every old policy except the staff ones from the phase 1 file.
    for p in select policyname from pg_policies
             where schemaname = 'public' and tablename = t
               and policyname not in ('conversations_staff_read', 'conversations_staff_update', 'messages_staff_read')
    loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;
