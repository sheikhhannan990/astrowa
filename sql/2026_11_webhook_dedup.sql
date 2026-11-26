-- Run once in Supabase → SQL Editor. Safe to re-run.
--
-- Stops duplicate messages caused by WhatsApp / Shopify re-sending the
-- same webhook, and cleans up the duplicates already in the inbox.

-- ---------- 1. Webhook dedup table ----------
-- The backend inserts one row per webhook it handles (incoming WhatsApp
-- message id, Shopify order, Shopify fulfillment). The primary key makes a
-- second delivery of the same event fail to insert, so it's skipped — even
-- when two PythonAnywhere workers receive it at the same moment.
create table if not exists public.processed_events (
  key         text primary key,
  created_at  timestamptz not null default now()
);
alter table public.processed_events enable row level security;

-- ---------- 2. Remove existing duplicate incoming messages ----------
-- Keeps the earliest copy of each incoming WhatsApp message and deletes
-- the repeats (same WhatsApp message id). Outgoing messages are untouched.
delete from public.messages m
using public.messages o
where m.direction = 'incoming'
  and o.direction = 'incoming'
  and m.whatsapp_message_id is not null
  and m.whatsapp_message_id = o.whatsapp_message_id
  and (o.created_at, o.id) < (m.created_at, m.id);

-- ---------- 3. Never store the same incoming message twice ----------
create unique index if not exists messages_incoming_wamid_uniq
  on public.messages (whatsapp_message_id)
  where direction = 'incoming' and whatsapp_message_id is not null;
