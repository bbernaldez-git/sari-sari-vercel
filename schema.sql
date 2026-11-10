create table if not exists products (
  id text primary key, name text not null, category text not null,
  price numeric not null check (price >= 0), stock int not null check (stock >= 0),
  tags text not null default '', image text not null default ''
);
create table if not exists orders (
  id text primary key, created timestamptz not null default now(),
  email text not null default '', name text not null, contact text not null,
  address text not null default '', method text not null,
  items jsonb not null, total numeric not null,
  status text not null default 'Pending', missing jsonb not null default '[]',
  admin_note text not null default '', note text not null default ''
);
create index if not exists orders_created_idx on orders (created desc);
create index if not exists orders_contact_idx on orders (contact);
create table if not exists admin_codes (email text primary key, code text not null, expires bigint not null);
create table if not exists sessions (token text primary key, email text not null, expires bigint not null);
