create table if not exists products (id text primary key, name text not null, category text not null,
  price numeric not null check (price >= 0), stock int not null check (stock >= 0), tags text not null default '', image text not null default '');
create table if not exists orders (id text primary key, created timestamptz not null default now(), email text not null default '',
  name text not null, contact text not null, address text not null default '', method text not null, items jsonb not null, total numeric not null,
  status text not null default 'Pending', missing jsonb not null default '[]', admin_note text not null default '', note text not null default '');
alter table orders add column if not exists rider text not null default '';
alter table orders add column if not exists delivery_status text not null default '';
create index if not exists orders_created_idx on orders (created desc);
create index if not exists orders_contact_idx on orders (contact);
create table if not exists admin_codes (email text primary key, code text not null, expires bigint not null);
create table if not exists sessions (token text primary key, email text not null, expires bigint not null);
create table if not exists staff (email text primary key, rid text unique not null, name text not null, role text not null,
  phone text not null default '', pass text not null, active boolean not null default true, last_seen bigint not null default 0);
alter table products add column if not exists barcode text not null default '';
create index if not exists products_barcode_idx on products (barcode);
create table if not exists store_sessions (id serial primary key, opened_at timestamptz not null default now(), opened_by text not null,
  start_amount numeric not null, closed_at timestamptz, closed_by text, end_amount numeric);
create table if not exists cash_entries (id serial primary key, session_id int not null, created timestamptz not null default now(),
  kind text not null, method text not null default 'Cash', amount numeric not null check (amount > 0), ref text not null default '',
  status text not null default 'Done', by_email text not null default '', released_at timestamptz);
create table if not exists pos_sales (id text primary key, session_id int, created timestamptz not null default now(), by_email text not null,
  items jsonb not null, total numeric not null, cash numeric);
