-- localhost: relational state. Git objects and refs live in the RepoObject Durable Object.

create table users (
  id text primary key,
  handle text not null unique collate nocase,
  display_name text not null,
  kind text not null check (kind in ('human', 'agent')),
  avatar_url text,
  created_at integer not null
);

create table identities (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  issuer text not null,
  subject text not null,
  email text,
  email_verified integer not null default 0,
  owner_email text,
  created_at integer not null,
  unique (issuer, subject)
);
create index identities_user on identities(user_id);

create table sessions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  created_at integer not null,
  expires_at integer not null,
  user_agent text
);
create index sessions_user on sessions(user_id);

create table tokens (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  name text not null,
  prefix text not null,
  hash text not null unique,
  scopes text not null,
  repo_id text,
  expires_at integer,
  last_used_at integer,
  created_at integer not null
);
create index tokens_user on tokens(user_id);

create table device_codes (
  id text primary key,
  device_code_hash text not null unique,
  user_code text not null unique,
  user_id text,
  status text not null check (status in ('pending', 'approved', 'denied', 'used')),
  scopes text not null,
  token_name text not null,
  expires_at integer not null,
  created_at integer not null
);

create table agent_registrations (
  id text primary key,
  claim_token_hash text not null unique,
  status text not null check (status in ('pending', 'claimed', 'expired')),
  claim_email text,
  user_id text,
  token_id text,
  created_at integer not null,
  expires_at integer not null
);

create table claim_attempts (
  id text primary key,
  registration_id text not null references agent_registrations(id) on delete cascade,
  attempt_token text not null unique,
  user_code_hash text not null,
  status text not null check (status in ('initiated', 'completed', 'expired')),
  expires_at integer not null,
  created_at integer not null
);

create table repos (
  id text primary key,
  owner_id text not null references users(id) on delete cascade,
  name text not null collate nocase,
  description text not null default '',
  visibility text not null check (visibility in ('public', 'private')),
  default_branch text not null default 'master',
  imported_from text,
  import_status text,
  created_at integer not null,
  updated_at integer not null,
  pushed_at integer,
  unique (owner_id, name)
);

create table collaborators (
  repo_id text not null references repos(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role text not null check (role in ('read', 'write', 'admin')),
  created_at integer not null,
  primary key (repo_id, user_id)
);

create table path_rules (
  id text primary key,
  repo_id text not null references repos(id) on delete cascade,
  pattern text not null,
  visibility text not null check (visibility in ('public', 'private')),
  created_at integer not null,
  unique (repo_id, pattern)
);

create table environments (
  id text primary key,
  repo_id text not null references repos(id) on delete cascade,
  name text not null,
  created_at integer not null,
  unique (repo_id, name)
);

create table env_vars (
  id text primary key,
  environment_id text not null references environments(id) on delete cascade,
  key text not null,
  value_enc text not null,
  is_secret integer not null default 1,
  created_at integer not null,
  updated_at integer not null,
  unique (environment_id, key)
);

create table pull_requests (
  id text primary key,
  repo_id text not null references repos(id) on delete cascade,
  number integer not null,
  title text not null,
  body text not null default '',
  author_id text not null references users(id),
  base_ref text not null,
  head_ref text not null,
  state text not null check (state in ('open', 'merged', 'closed')),
  merge_sha text,
  ai_summary text,
  created_at integer not null,
  updated_at integer not null,
  merged_at integer,
  unique (repo_id, number)
);

create table pr_comments (
  id text primary key,
  pr_id text not null references pull_requests(id) on delete cascade,
  author_id text not null references users(id),
  body text not null,
  created_at integer not null
);
create index pr_comments_pr on pr_comments(pr_id);

create table events (
  id text primary key,
  repo_id text not null references repos(id) on delete cascade,
  actor_id text,
  type text not null,
  payload text not null,
  summary text,
  created_at integer not null
);
create index events_repo on events(repo_id, created_at desc);
