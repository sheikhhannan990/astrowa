-- Phase 1: team accounts, order workflow, notes, follow-ups, activity log.
--
-- Run once in Supabase → SQL Editor. Safe to re-run.
-- This file only ADDS things — the current inbox keeps working after you
-- run it. The follow-up file 2026_11_phase1_lockdown.sql (run later, once
-- you can log in to the new inbox) is what closes public access.

-- ---------- Team members ----------
-- One row per person allowed into the inbox. Accounts themselves live in
-- Supabase Auth; this table says who is staff and what role they have.
create table if not exists public.staff (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  name        text not null,
  email       text,
  role        text not null default 'agent' check (role in ('admin', 'agent')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
alter table public.staff enable row level security;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff where user_id = auth.uid() and active)
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff where user_id = auth.uid() and active and role = 'admin')
$$;

drop policy if exists staff_read on public.staff;
create policy staff_read on public.staff for select to authenticated using (public.is_staff());

-- ---------- Orders (one row per Shopify order) ----------
create table if not exists public.orders (
  id                uuid primary key default gen_random_uuid(),
  shopify_order_id  text unique,
  order_number      text not null,
  phone             text not null,
  customer_name     text,
  conversation_id   uuid references public.conversations(id) on delete set null,
  total             numeric,
  items_text        text,
  payment_method    text not null default 'cod' check (payment_method in ('cod', 'bank')),
  shipping_address  jsonb,
  city              text,
  -- pending → confirmed / cancelled → shipped → delivered / returned
  stage             text not null default 'pending'
                    check (stage in ('pending', 'confirmed', 'cancelled', 'shipped', 'delivered', 'returned')),
  confirmed_via     text,          -- button | whatsapp | call | payment | manual
  cancel_reason     text,
  flags             text[] not null default '{}',
  call_attempts     integer not null default 0,
  last_call_outcome text,
  last_call_at      timestamptz,
  tracking_number   text,
  stage_changed_at  timestamptz,
  stage_changed_by  text,          -- staff name, or 'Customer' / 'Shopify'
  order_created_at  timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (phone, order_number)
);
create index if not exists orders_created_idx on public.orders (order_created_at desc);
create index if not exists orders_conversation_idx on public.orders (conversation_id);
create index if not exists orders_stage_idx on public.orders (stage);
alter table public.orders enable row level security;
drop policy if exists orders_read on public.orders;
create policy orders_read on public.orders for select to authenticated using (public.is_staff());

-- ---------- Internal notes (never sent to the customer) ----------
create table if not exists public.notes (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid references public.conversations(id) on delete cascade,
  order_id         uuid references public.orders(id) on delete cascade,
  phone            text,               -- set for customer-level notes (shown on all their orders)
  body             text not null,
  author_id        uuid,
  author_name      text,
  created_at       timestamptz not null default now()
);
create index if not exists notes_conversation_idx on public.notes (conversation_id);
create index if not exists notes_phone_idx on public.notes (phone);
alter table public.notes enable row level security;
drop policy if exists notes_read on public.notes;
create policy notes_read on public.notes for select to authenticated using (public.is_staff());

-- ---------- Follow-ups / reminders (internal only, nothing is sent) ----------
create table if not exists public.followups (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid references public.conversations(id) on delete cascade,
  order_id         uuid references public.orders(id) on delete cascade,
  kind             text not null default 'custom' check (kind in ('call', 'awaiting_customer', 'custom')),
  due_at           timestamptz not null,
  note             text,
  auto             boolean not null default false,
  created_by_name  text,
  done_at          timestamptz,
  done_by_name     text,
  created_at       timestamptz not null default now()
);
create index if not exists followups_open_idx on public.followups (due_at) where done_at is null;
create index if not exists followups_conversation_idx on public.followups (conversation_id);
alter table public.followups enable row level security;
drop policy if exists followups_read on public.followups;
create policy followups_read on public.followups for select to authenticated using (public.is_staff());

-- ---------- Activity log (who did what, when) ----------
create table if not exists public.activity (
  id               bigint generated always as identity primary key,
  created_at       timestamptz not null default now(),
  actor_id         uuid,
  actor_name       text,
  kind             text not null,
  summary          text,
  conversation_id  uuid,
  order_id         uuid,
  meta             jsonb
);
create index if not exists activity_created_idx on public.activity (created_at desc);
create index if not exists activity_actor_idx on public.activity (actor_id, created_at desc);
alter table public.activity enable row level security;
drop policy if exists activity_read on public.activity;
create policy activity_read on public.activity for select to authenticated using (public.is_admin());

-- Read access for logged-in users (rows are still filtered by the policies
-- above); all writes go through the backend.
grant select on public.staff, public.orders, public.notes, public.followups, public.activity to authenticated;
revoke all on public.staff, public.orders, public.notes, public.followups, public.activity from anon;

-- ---------- New columns on existing tables ----------
alter table public.conversations add column if not exists needs_reply boolean not null default false;
alter table public.conversations add column if not exists waiting_since timestamptz;
alter table public.messages add column if not exists sent_by uuid;
alter table public.messages add column if not exists sent_by_name text;
alter table public.quick_replies add column if not exists category text;
alter table public.quick_replies add column if not exists use_count integer not null default 0;
alter table public.quick_replies add column if not exists last_used_at timestamptz;

create index if not exists messages_conversation_created_idx on public.messages (conversation_id, created_at);
create index if not exists conversations_needs_reply_idx on public.conversations (waiting_since) where needs_reply;

-- Logged-in staff can read chats and mark them as read. These policies sit
-- alongside whatever public access exists today; the lockdown file removes
-- the public access later.
drop policy if exists conversations_staff_read on public.conversations;
create policy conversations_staff_read on public.conversations for select to authenticated using (public.is_staff());
drop policy if exists conversations_staff_update on public.conversations;
create policy conversations_staff_update on public.conversations for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
drop policy if exists messages_staff_read on public.messages;
create policy messages_staff_read on public.messages for select to authenticated using (public.is_staff());

-- ---------- Quick reply categories and usage ----------
update public.quick_replies set category = 'Payment'
  where category is null and title ilike any (array['%payment%', '%bank%', '%advance%']);
update public.quick_replies set category = 'Address'
  where category is null and title ilike any (array['%address%']);
update public.quick_replies set category = 'Orders'
  where category is null and title ilike any (array['%cancel%', '%replacement%', '%forward%', '%return%', '%refund%', '%policy%']);
update public.quick_replies set category = 'General' where category is null;

-- Seed usage counts from history, so the replies you already send most
-- appear first from day one.
update public.quick_replies q
set use_count = sub.n
from (
  select q2.id, count(m.id)::int as n
  from public.quick_replies q2
  join public.messages m
    on m.direction = 'outgoing'
   and m.type = 'text'
   and lower(regexp_replace(trim(m.body), '\s+', ' ', 'g'))
       = lower(regexp_replace(trim(q2.body), '\s+', ' ', 'g'))
  group by q2.id
) sub
where q.id = sub.id and q.use_count = 0;

-- ---------- Backfill orders from the last 10 days ----------
-- Built from the confirmation messages the inbox already logged (they carry
-- the order details), so the Today queue is useful immediately.
insert into public.orders (order_number, phone, customer_name, conversation_id, total, items_text,
                           payment_method, shipping_address, city, stage, tracking_number,
                           flags, order_created_at, stage_changed_by)
select distinct on (c.phone, m.raw_payload->>'order_number')
  m.raw_payload->>'order_number',
  c.phone,
  coalesce(m.raw_payload->>'customer_name', c.customer_name),
  c.id,
  nullif(m.raw_payload->>'total_price', '')::numeric,
  m.raw_payload->>'products_text',
  case when m.body ilike '%Payment Details%' then 'bank' else 'cod' end,
  m.raw_payload->'shipping_address',
  m.raw_payload->'shipping_address'->>'city',
  case
    when f.tracking is not null then 'shipped'
    when c.order_id = m.raw_payload->>'order_number' and c.is_cancelled then 'cancelled'
    when c.order_id = m.raw_payload->>'order_number' and c.last_template in ('confirmed', 'paid') then 'confirmed'
    when c.order_id = m.raw_payload->>'order_number' and c.last_template = 'fulfilled' then 'shipped'
    else 'pending'
  end,
  f.tracking,
  case when c.order_id = m.raw_payload->>'order_number' and c.is_not_on_whatsapp
       then array['not_on_whatsapp'] else '{}'::text[] end,
  m.created_at,
  'Backfill'
from public.messages m
join public.conversations c on c.id = m.conversation_id
left join lateral (
  select f.raw_payload->>'tracking_number' as tracking
  from public.messages f
  where f.conversation_id = m.conversation_id
    and f.type = 'template'
    and f.raw_payload ? 'tracking_company'
    and f.raw_payload->>'order_number' = m.raw_payload->>'order_number'
  limit 1
) f on true
where m.type = 'template'
  and m.created_at > now() - interval '10 days'
  and m.raw_payload ? 'total_price'
  and coalesce(m.raw_payload->>'order_number', '') <> ''
order by c.phone, m.raw_payload->>'order_number', m.created_at
on conflict (phone, order_number) do nothing;

-- Chats where the customer's latest message (last 2 days) has no reply yet.
update public.conversations c
set needs_reply = true, waiting_since = last_in.created_at
from (
  select distinct on (conversation_id) conversation_id, created_at, body, type
  from public.messages
  where direction = 'incoming'
    and type not in ('button', 'reaction', 'sticker')
    and created_at > now() - interval '2 days'
  order by conversation_id, created_at desc
) last_in
where c.id = last_in.conversation_id
  and not c.needs_reply
  and not (last_in.type = 'text' and lower(trim(last_in.body)) ~
       '^(ok+|okay|okk+|oky|okok|ok sir|sure|alright|perfect|done|thanks?|thank ?you|thankyou|ty|jazak\S*|👍\S*|great|nice|good|fine|theek|thik|acha|jee|ji)\W{0,3}( ?(thanks?|thank ?you|thankyou|sir|bhai|g|ji|jee))?\W{0,3}$')
  and not exists (
    select 1 from public.messages o
    where o.conversation_id = c.id
      and o.direction = 'outgoing'
      and o.type <> 'template'
      and coalesce(o.raw_payload->>'auto_reply', '') <> 'confirm'
      and o.created_at > last_in.created_at
  );

-- ---------- Live updates for the new tables ----------
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['orders', 'followups', 'notes'] loop
      if not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
