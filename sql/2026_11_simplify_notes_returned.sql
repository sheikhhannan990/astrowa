-- Simpler inbox: latest note shown on each chat, and "refused before"
-- warnings for customers whose earlier order came back.
--
-- Run once in Supabase → SQL Editor (after the phase 1 file). Safe to re-run.

-- Latest note on each chat, so it's visible in the chat list and header.
alter table public.conversations add column if not exists last_note text;
alter table public.conversations add column if not exists last_note_by text;
alter table public.conversations add column if not exists last_note_at timestamptz;

update public.conversations c
set last_note = n.body, last_note_by = n.author_name, last_note_at = n.created_at
from (
  select distinct on (conversation_id) conversation_id, body, author_name, created_at
  from public.notes
  where conversation_id is not null
  order by conversation_id, created_at desc
) n
where c.id = n.conversation_id and c.last_note is null;

-- Customers you've already asked for an advance because they refused an
-- earlier order: flag their open orders "refused before".
update public.orders o
set flags = array_append(o.flags, 'refused_before')
where not ('refused_before' = any(o.flags))
  and o.stage in ('pending', 'confirmed')
  and exists (
    select 1
    from public.conversations c
    join public.messages m on m.conversation_id = c.id
    where c.phone = o.phone
      and m.direction = 'outgoing'
      and (m.body ilike '%refused to receive%' or m.body ilike '%previous order was not received%')
  );
