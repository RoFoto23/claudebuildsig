-- BuildSignal database schema (Postgres 17 / Supabase). Exported from the live project buildsignal-prod on 2026-10-11.
-- Run in the Supabase SQL editor on an empty project to recreate the database.
-- Security model: RLS is enabled on every table with NO policies, so the public (anon) key can read and write nothing.
-- The server uses the secret key (bypasses RLS). The anon key may only call join_waitlist() and log_event().

create table public.accounts (
  id uuid not null default gen_random_uuid(),
  email text not null,
  role text not null default 'customer',
  status text not null default 'active',
  session_epoch integer not null default 1,
  created_at timestamptz not null default now(),
  last_login_at timestamptz,
  consent_at timestamptz,
  marketing_consent boolean not null default false,
  unsubscribed_at timestamptz,
  digest_paused boolean not null default false,
  stripe_customer_id text,
  billing_status text not null default 'none',
  plan_id text,
  trial_end timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  last_digest_at timestamptz,
  last_open_at timestamptz,
  referral_code text,
  referred_by text
);
create table public.admin_totp (
  account_id uuid not null,
  secret_enc text not null,
  confirmed_at timestamptz,
  last_used_step bigint not null default 0
);
create table public.audit_log (
  id bigint generated always as identity,
  ts timestamptz not null default now(),
  actor text not null,
  action text not null,
  target text,
  detail jsonb not null default '{}'::jsonb
);
create table public.digests (
  id uuid not null default gen_random_uuid(),
  account_id uuid not null,
  kind text not null,
  item_count integer not null default 0,
  digest_key text not null,
  sent_at timestamptz,
  opened_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.events (
  id bigint generated always as identity,
  ts timestamptz not null default now(),
  name text not null,
  account_id uuid,
  anon_id text,
  props jsonb not null default '{}'::jsonb
);
create table public.job_runs (
  id uuid not null default gen_random_uuid(),
  job text not null,
  run_key text not null,
  status text not null default 'running',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  stats jsonb not null default '{}'::jsonb,
  error text
);
create table public.leads (
  id uuid not null default gen_random_uuid(),
  email text not null,
  trade text,
  zip text,
  consent boolean not null default false,
  source text,
  created_at timestamptz not null default now()
);
create table public.login_tokens (
  token_hash text not null,
  account_id uuid not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.matches (
  id uuid not null default gen_random_uuid(),
  account_id uuid not null,
  opportunity_id uuid not null,
  score integer not null,
  factors jsonb not null default '[]'::jsonb,
  checklist jsonb not null default '[]'::jsonb,
  digest_id uuid,
  disposition text,
  reason text,
  action text not null default 'none',
  note text,
  delivered_at timestamptz,
  disposition_at timestamptz,
  action_at timestamptz,
  reminders_sent integer[] not null default '{}',
  change_alerted_version integer,
  created_at timestamptz not null default now()
);
create table public.opportunities (
  id uuid not null default gen_random_uuid(),
  source text not null,
  source_id text not null,
  kind text not null,
  title text not null,
  agency text,
  jurisdiction text,
  address text,
  zip text,
  stage text,
  value numeric,
  sqft numeric,
  units numeric,
  issued_date date,
  deadline timestamptz,
  url text,
  gc_name text,
  applicant text,
  scope text,
  work_type text,
  permit_type text,
  tags text[] not null default '{}',
  raw jsonb,
  fingerprint text not null,
  parent_key text,
  version integer not null default 1,
  status text not null default 'active',
  is_sample boolean not null default false,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  changed_at timestamptz
);
create table public.opportunity_versions (
  id uuid not null default gen_random_uuid(),
  opportunity_id uuid not null,
  version integer not null,
  fingerprint text not null,
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);
create table public.outbox (
  id uuid not null default gen_random_uuid(),
  account_id uuid,
  to_email text not null,
  subject text not null,
  html text not null,
  text_body text not null,
  kind text not null,
  status text not null default 'queued',
  provider_id text,
  error text,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create table public.plans (
  id text not null,
  name text not null,
  price_cents integer not null,
  trade_group_limit integer not null,
  area_limit integer not null,
  features jsonb not null default '{}'::jsonb,
  stripe_price_id text,
  trial_days integer not null default 14,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);
create table public.profiles (
  account_id uuid not null,
  business_name text,
  contact_name text,
  phone text,
  trades text[] not null default '{}',
  jurisdictions text[] not null default '{}',
  zips text[] not null default '{}',
  min_value numeric,
  max_value numeric,
  license_number text,
  license_classes text[] not null default '{}',
  certifications text[] not null default '{}',
  bonding_limit numeric,
  insurance_limit numeric,
  digest_frequency text not null default 'daily',
  channel text not null default 'email',
  rate_card jsonb not null default '[]'::jsonb,
  capability_blurb text,
  feedback_weights jsonb not null default '{}'::jsonb,
  onboarded_at timestamptz,
  updated_at timestamptz not null default now()
);
create table public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  count integer not null default 0
);
create table public.settings (
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
create table public.source_config (
  source text not null,
  label text not null,
  enabled boolean not null default false,
  terms_url text,
  terms_reviewed_at timestamptz,
  terms_notes text,
  last_run_at timestamptz,
  last_ok_at timestamptz,
  last_count integer,
  baseline_count numeric,
  last_error text,
  consecutive_failures integer not null default 0,
  auto_disabled boolean not null default false,
  updated_at timestamptz not null default now()
);
create table public.stripe_events (
  id text not null,
  type text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text
);
create table public.suppressions (
  email text not null,
  reason text not null,
  created_at timestamptz not null default now()
);

alter table public.accounts add constraint accounts_pkey primary key (id);
alter table public.accounts add constraint accounts_email_key unique (email);
alter table public.accounts add constraint accounts_referral_code_key unique (referral_code);
alter table public.accounts add constraint accounts_stripe_customer_id_key unique (stripe_customer_id);
alter table public.admin_totp add constraint admin_totp_pkey primary key (account_id);
alter table public.audit_log add constraint audit_log_pkey primary key (id);
alter table public.digests add constraint digests_pkey primary key (id);
alter table public.digests add constraint digests_digest_key_key unique (digest_key);
alter table public.events add constraint events_pkey primary key (id);
alter table public.job_runs add constraint job_runs_pkey primary key (id);
alter table public.job_runs add constraint job_runs_job_run_key_key unique (job, run_key);
alter table public.leads add constraint leads_pkey primary key (id);
alter table public.leads add constraint leads_email_key unique (email);
alter table public.login_tokens add constraint login_tokens_pkey primary key (token_hash);
alter table public.matches add constraint matches_pkey primary key (id);
alter table public.matches add constraint matches_account_id_opportunity_id_key unique (account_id, opportunity_id);
alter table public.opportunities add constraint opportunities_pkey primary key (id);
alter table public.opportunities add constraint opportunities_source_source_id_key unique (source, source_id);
alter table public.opportunity_versions add constraint opportunity_versions_pkey primary key (id);
alter table public.opportunity_versions add constraint opportunity_versions_opportunity_id_version_key unique (opportunity_id, version);
alter table public.outbox add constraint outbox_pkey primary key (id);
alter table public.outbox add constraint outbox_idempotency_key_key unique (idempotency_key);
alter table public.plans add constraint plans_pkey primary key (id);
alter table public.profiles add constraint profiles_pkey primary key (account_id);
alter table public.rate_limits add constraint rate_limits_pkey primary key (key, window_start);
alter table public.settings add constraint settings_pkey primary key (key);
alter table public.source_config add constraint source_config_pkey primary key (source);
alter table public.stripe_events add constraint stripe_events_pkey primary key (id);
alter table public.suppressions add constraint suppressions_pkey primary key (email);

alter table public.accounts add constraint accounts_billing_status_check check (billing_status in ('none','trialing','active','past_due','canceled','paused'));
alter table public.accounts add constraint accounts_email_check check (email = lower(email));
alter table public.accounts add constraint accounts_role_check check (role in ('customer','admin'));
alter table public.accounts add constraint accounts_status_check check (status in ('active','deleted'));
alter table public.digests add constraint digests_kind_check check (kind in ('daily','weekly','empty'));
alter table public.job_runs add constraint job_runs_status_check check (status in ('running','ok','failed'));
alter table public.leads add constraint leads_email_check check (email = lower(email));
alter table public.matches add constraint matches_action_check check (action in ('none','contacted','bid_submitted','won','lost'));
alter table public.matches add constraint matches_disposition_check check (disposition in ('interested','not_for_me','already_knew'));
alter table public.opportunities add constraint opportunities_kind_check check (kind in ('permit_lead','public_bid','manual'));
alter table public.opportunities add constraint opportunities_status_check check (status in ('active','hidden','closed'));
alter table public.outbox add constraint outbox_status_check check (status in ('queued','sent','simulated','failed','bounced','complained'));
alter table public.plans add constraint plans_price_cents_check check (price_cents > 0 and price_cents <= 5000); -- hard cap: no single charge above $50
alter table public.profiles add constraint profiles_channel_check check (channel = 'email');
alter table public.profiles add constraint profiles_digest_frequency_check check (digest_frequency in ('daily','weekly'));

alter table public.admin_totp add constraint admin_totp_account_id_fkey foreign key (account_id) references public.accounts(id) on delete cascade;
alter table public.digests add constraint digests_account_id_fkey foreign key (account_id) references public.accounts(id) on delete cascade;
alter table public.login_tokens add constraint login_tokens_account_id_fkey foreign key (account_id) references public.accounts(id) on delete cascade;
alter table public.matches add constraint matches_account_id_fkey foreign key (account_id) references public.accounts(id) on delete cascade;
alter table public.matches add constraint matches_digest_id_fkey foreign key (digest_id) references public.digests(id) on delete set null;
alter table public.matches add constraint matches_opportunity_id_fkey foreign key (opportunity_id) references public.opportunities(id) on delete cascade;
alter table public.opportunity_versions add constraint opportunity_versions_opportunity_id_fkey foreign key (opportunity_id) references public.opportunities(id) on delete cascade;
alter table public.outbox add constraint outbox_account_id_fkey foreign key (account_id) references public.accounts(id) on delete set null;
alter table public.profiles add constraint profiles_account_id_fkey foreign key (account_id) references public.accounts(id) on delete cascade;

create index events_name_ts_idx on public.events using btree (name, ts desc);
create index matches_account_idx on public.matches using btree (account_id, created_at desc);
create index opportunities_issued_idx on public.opportunities using btree (issued_date desc);
create index opportunities_status_idx on public.opportunities using btree (status, last_seen desc);
create index outbox_status_idx on public.outbox using btree (status, created_at desc);

-- Row level security: enabled everywhere, no policies. Only the server secret key can touch data.
alter table public.accounts enable row level security;
alter table public.admin_totp enable row level security;
alter table public.audit_log enable row level security;
alter table public.digests enable row level security;
alter table public.events enable row level security;
alter table public.job_runs enable row level security;
alter table public.leads enable row level security;
alter table public.login_tokens enable row level security;
alter table public.matches enable row level security;
alter table public.opportunities enable row level security;
alter table public.opportunity_versions enable row level security;
alter table public.outbox enable row level security;
alter table public.plans enable row level security;
alter table public.profiles enable row level security;
alter table public.rate_limits enable row level security;
alter table public.settings enable row level security;
alter table public.source_config enable row level security;
alter table public.stripe_events enable row level security;
alter table public.suppressions enable row level security;

-- Functions (SECURITY DEFINER, fixed search_path).
create or replace function public.claim_job(p_job text, p_key text) returns boolean
language plpgsql security definer set search_path to 'public' as $$
declare n int;
begin
  insert into public.job_runs(job, run_key) values (p_job, p_key) on conflict (job, run_key) do nothing;
  get diagnostics n = row_count;
  return n = 1;
end $$;

create or replace function public.join_waitlist(p_email text, p_trade text, p_zip text, p_consent boolean, p_source text) returns text
language plpgsql security definer set search_path to 'public' as $$
declare e text := lower(trim(p_email));
begin
  if e is null or e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(e) > 254 then return 'invalid'; end if;
  if not coalesce(p_consent, false) then return 'consent_required'; end if;
  if (select count(*) from public.leads where created_at > now() - interval '10 minutes') > 60 then return 'rate_limited'; end if;
  insert into public.leads(email, trade, zip, consent, source)
  values (e, left(p_trade, 40), left(p_zip, 10), true, left(p_source, 40))
  on conflict (email) do nothing;
  return 'ok';
end $$;

create or replace function public.log_event(p_name text, p_anon text, p_props jsonb) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  if p_name !~ '^[a-z_]{2,40}$' then return; end if;
  if (select count(*) from public.events where ts > now() - interval '1 minute') > 600 then return; end if;
  insert into public.events(name, anon_id, props) values (p_name, left(p_anon, 40), coalesce(p_props, '{}'::jsonb));
end $$;

create or replace function public.rl_hit(p_key text, p_window timestamptz) returns integer
language plpgsql security definer set search_path to 'public' as $$
declare c int;
begin
  insert into public.rate_limits(key, window_start, count) values (p_key, p_window, 1)
  on conflict (key, window_start) do update set count = public.rate_limits.count + 1
  returning count into c;
  return c;
end $$;

revoke execute on all functions in schema public from public;
grant execute on function public.claim_job(text, text) to service_role;
grant execute on function public.rl_hit(text, timestamptz) to service_role;
grant execute on function public.join_waitlist(text, text, text, boolean, text) to service_role;
grant execute on function public.log_event(text, text, jsonb) to service_role;

-- Seed data. Sources start DISABLED until the owner reviews each source's terms in the admin Sources screen.
insert into public.plans (id, name, price_cents, trade_group_limit, area_limit, features, trial_days) values
  ('starter', 'Starter', 2900, 1, 1, '{"digest":true,"eligibility":true,"kit":false,"pipeline":false,"reminders":false}', 14),
  ('pro',     'Pro',     4900, 3, 2, '{"digest":true,"eligibility":true,"kit":true,"pipeline":true,"reminders":true}', 14);
insert into public.source_config (source, label, terms_url) values
  ('mesa_permits',    'City of Mesa building permits (open data)', 'https://data.mesaaz.gov/stories/s/Terms-of-Use-page/2dcd-j2nx/'),
  ('phoenix_permits', 'City of Phoenix current permits (ArcGIS)',  'https://maps.phoenix.gov/pub/rest/services/Public/Planning_Permit/MapServer/1'),
  ('sam_gov',         'SAM.gov Opportunities API (federal)',       'https://open.gsa.gov/api/get-opportunities-public-api/');
insert into public.settings (key, value) values
  ('scoring_weights', '{"fit":30,"timing":25,"scale":15,"access":15,"evidence":15}'),
  ('thresholds', '{"max_items":5,"urgent_min":80,"deliver_min":50,"freshness_days":45}'),
  ('email_unit_cost_cents', '0.1');

-- ---- Forwarded-alert digest (db/migrations/2026-10-inbox.sql) ----

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
