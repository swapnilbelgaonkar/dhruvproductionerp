-- Database-backed file store for hosts without a persistent disk (serverless demo).
-- Objects are immutable: the primary key stops an overwrite, as the disk adapter's 'wx' flag does.
create table if not exists sys.file_objects (
  key        text primary key,
  data       bytea not null,
  mime       text,
  created_at timestamptz not null default now()
);
