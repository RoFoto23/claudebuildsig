-- Forwarded-alert digest ("inbox" feature). Apply once in the Supabase SQL editor AFTER db/schema.sql.
-- Design: docs/inbox-detailed-design.md section 2. Nothing here changes existing rows.
-- Security model is unchanged: RLS on, no policies; only the server secret key can read or write.

create table if not exists public.inbox_addresses (
  id uuid not null default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  local_part text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (id),
  unique (local_part)
);
create index if not exists inbox_addresses_account on public.inbox_addresses (account_id) where revoked_at is null;

create table if not exists public.inbound_messages (
  id uuid not null default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  provider_email_id text not null,
  received_at timestamptz not null default now(),
  from_domain text,
  subject text,
  body_text text,
  auth jsonb,
  status text not null default 'received'
    check (status in ('received','fetched','parsed','held','dropped','failed','expired')),
  parse_method text check (parse_method in ('template','rules','ai','none')),
  confidence numeric,
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  error text,
  opportunity_ids uuid[] not null default '{}',
  kind text not null default 'alert' check (kind in ('alert','forward_confirmation','ignored')),
  confirmation_code text,
  held_items jsonb,
  expires_at timestamptz not null default (now() + interval '30 days'),
  primary key (id),
  unique (provider_email_id)
);
create index if not exists inbound_messages_sweep on public.inbound_messages (status, next_attempt_at);
create index if not exists inbound_messages_account on public.inbound_messages (account_id, received_at desc);

create table if not exists public.llm_calls (
  id uuid not null default gen_random_uuid(),
  message_id uuid references public.inbound_messages(id) on delete set null,
  account_id uuid references public.accounts(id) on delete set null, -- keep spend history when an account is deleted
  provider text not null,
  model text not null,
  tokens_in integer,
  tokens_out integer,
  cost_usd numeric(10,6),
  latency_ms integer,
  confidence numeric,
  outcome text not null,
  created_at timestamptz not null default now(),
  primary key (id)
);
create index if not exists llm_calls_month on public.llm_calls (created_at);

alter table public.opportunities
  add column if not exists owner_account_id uuid references public.accounts(id) on delete cascade,
  add column if not exists provenance jsonb,
  add column if not exists also_seen_via text[] not null default '{}';
create index if not exists opportunities_owner on public.opportunities (owner_account_id) where owner_account_id is not null;

alter table public.inbox_addresses enable row level security;
alter table public.inbound_messages enable row level security;
alter table public.llm_calls enable row level security;

-- Settings (inbox stays OFF until the owner turns it on in Admin; the AI fallback stays OFF until a monthly cap is set).
insert into public.settings (key, value) values
  ('inbox.enabled', 'false'::jsonb),
  ('inbox.daily_limit', '40'::jsonb),
  ('inbox.max_chars', '20000'::jsonb),
  ('inbox.parse_threshold', '0.6'::jsonb),
  ('llm.enabled', 'false'::jsonb)
on conflict (key) do nothing;
