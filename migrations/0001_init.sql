PRAGMA foreign_keys = ON;

CREATE TABLE clients (
  client_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  providers TEXT NOT NULL DEFAULT '["github"]',
  created_at INTEGER NOT NULL
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE identities (
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_user_id)
);
CREATE INDEX identities_account_idx ON identities(account_id);

CREATE TABLE oauth_transactions (
  state_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('authorization_code', 'device', 'session')),
  client_id TEXT NOT NULL REFERENCES clients(client_id),
  redirect_uri TEXT,
  app_state TEXT,
  provider TEXT NOT NULL,
  code_challenge TEXT,
  provider_verifier TEXT,
  provider_nonce TEXT,
  device_code_hash TEXT,
  browser_binding_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE authorization_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(client_id),
  redirect_uri TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  provider_sub TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE device_grants (
  device_code_hash TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES clients(client_id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
  account_id TEXT REFERENCES accounts(id),
  provider_sub TEXT,
  expires_at INTEGER NOT NULL,
  interval_seconds INTEGER NOT NULL,
  last_polled_at INTEGER,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE consents (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  client_id TEXT NOT NULL REFERENCES clients(client_id),
  scopes TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, client_id)
);

CREATE TABLE consent_requests (
  request_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(client_id),
  redirect_uri TEXT NOT NULL,
  app_state TEXT NOT NULL,
  provider TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '["openid"]',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE browser_sessions (
  session_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX browser_sessions_account_idx ON browser_sessions(account_id);

CREATE TABLE rate_limits (
  bucket TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, key_hash, window_start)
);
CREATE INDEX rate_limits_cleanup_idx ON rate_limits(expires_at);

CREATE TABLE csrf_tokens (
  token_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Same-origin local demo client. Finalize the production URI during deployment.
INSERT INTO clients (client_id, name, redirect_uris, providers, created_at)
VALUES ('triad-demo', 'Triad demo', '["http://localhost:8787/demo/callback/"]', '["github"]', unixepoch());

INSERT INTO clients (client_id, name, redirect_uris, providers, created_at)
VALUES ('triad-account', 'Triad account', '[]', '["github"]', unixepoch());
