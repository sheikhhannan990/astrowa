-- Run once in Supabase → SQL Editor. Safe to re-run.
--
-- Adds:
--   1. quick_replies          saved messages for the inbox composer (⚡ button)
--   2. customer_orders        one row per Shopify order per phone, used to
--                             count how many orders a customer has placed
--   3. conversations.order_count   shown in the chat's Shipping address panel

-- ---------- 1. Quick replies ----------
create table if not exists public.quick_replies (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  body        text not null,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);
-- Only the backend (service role) touches this table; RLS with no
-- policies keeps it closed to the public anon key.
alter table public.quick_replies enable row level security;

-- Seed the default messages only if the table is empty.
insert into public.quick_replies (title, body, sort_order)
select * from (values
  ('Please wait',
   E'Thank you for reaching out to AstroLamps! ✨ A member of our team will get back to you shortly. We appreciate your patience.',
   1),
  ('Payment received',
   E'Thank you! We''ve received your payment and your order has been marked as paid. ✅\n\nIt will be delivered within 3–4 working days, InshaAllah. We appreciate your trust in AstroLamps.',
   2),
  ('Advance payment (refused order)',
   E'We noticed that your previous order was not received at the time of delivery. To process this new order, we kindly require an advance payment of PKR 200.\n\nBank details:\nAccount Title: ABDUL HANNAN\nBank: Askari Bank Limited, Lahore\nAccount Number: 01410320215569\nIBAN: PK75ASCM0001410320215569\n\nKindly share the transaction screenshot here once the payment is done. Thank you for your understanding.',
   3),
  ('Bank details',
   E'Please find our bank details below:\n\nAccount Title: ABDUL HANNAN\nBank: Askari Bank Limited, Lahore\nAccount Number: 01410320215569\nIBAN: PK75ASCM0001410320215569\n\nKindly share a screenshot here once the payment has been made.',
   4),
  ('Refund & warranty policy',
   E'All AstroLamps lamps come with a 30-day refund policy and a 1-year replacement warranty, so you can order with complete peace of mind. 🛡️\n\nIf you face any issue with your product, please don''t hesitate to reach out. Our team is always here to help.',
   5)
) as seed(title, body, sort_order)
where not exists (select 1 from public.quick_replies);

-- ---------- 2. Customer orders ----------
create table if not exists public.customer_orders (
  id                uuid primary key default gen_random_uuid(),
  phone             text not null,
  order_number      text not null,
  shopify_order_id  text,
  created_at        timestamptz not null default now(),
  unique (phone, order_number)
);

alter table public.customer_orders enable row level security;
create index if not exists customer_orders_phone_idx on public.customer_orders (phone);

-- Backfill from orders the inbox has already messaged about, so existing
-- repeat customers are counted correctly from day one.
insert into public.customer_orders (phone, order_number, created_at)
select c.phone, m.raw_payload->>'order_number', min(m.created_at)
from public.messages m
join public.conversations c on c.id = m.conversation_id
where m.type = 'template'
  and c.phone is not null
  and coalesce(m.raw_payload->>'order_number', '') <> ''
group by c.phone, m.raw_payload->>'order_number'
on conflict (phone, order_number) do nothing;

-- ---------- 3. Order count on conversations ----------
alter table public.conversations add column if not exists order_count integer;

update public.conversations c
set order_count = sub.cnt
from (
  select phone, count(*)::int as cnt
  from public.customer_orders
  group by phone
) sub
where sub.phone = c.phone;
