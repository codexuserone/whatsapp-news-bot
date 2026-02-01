create extension if not exists "pgcrypto";

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  collection text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists documents_collection_idx on public.documents (collection);
create index if not exists documents_created_at_idx on public.documents (created_at desc);
