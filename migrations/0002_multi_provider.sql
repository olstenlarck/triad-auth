DELETE FROM consent_requests;
DELETE FROM oauth_transactions;
DELETE FROM authorization_codes;
DELETE FROM device_grants;

ALTER TABLE oauth_transactions ADD COLUMN scopes TEXT NOT NULL DEFAULT '["openid"]';
ALTER TABLE authorization_codes ADD COLUMN provider TEXT NOT NULL DEFAULT 'github';
ALTER TABLE authorization_codes ADD COLUMN scopes TEXT NOT NULL DEFAULT '["openid"]';
ALTER TABLE authorization_codes ADD COLUMN claims_ciphertext TEXT;
ALTER TABLE device_grants ADD COLUMN provider TEXT NOT NULL DEFAULT 'github';
ALTER TABLE device_grants ADD COLUMN scopes TEXT NOT NULL DEFAULT '["openid"]';
ALTER TABLE device_grants ADD COLUMN claims_ciphertext TEXT;

UPDATE clients SET providers = '["google","github","twitter"]'
WHERE client_id IN ('triad-demo', 'triad-account');
