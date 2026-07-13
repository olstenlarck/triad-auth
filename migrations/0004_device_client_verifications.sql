CREATE TABLE device_client_verifications (
  client_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX device_client_verifications_expiry_idx
ON device_client_verifications(expires_at);
