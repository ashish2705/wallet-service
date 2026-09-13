create extension if not exists pgcrypto;

create table if not exists wallets (
  id uuid primary key default gen_random_uuid(),
  user_id text not null unique,
  balance_paise bigint not null default 0 check (balance_paise >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists transfers (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  from_wallet_id uuid not null references wallets(id),
  to_wallet_id uuid not null references wallets(id),
  amount_paise bigint not null check (amount_paise > 0),
  status text not null check (status in ('succeeded', 'declined_insufficient_funds', 'pending')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
