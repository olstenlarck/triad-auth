-- Tokens minted for an auth.md registration remember it, so revoking one revokes them all.

alter table tokens add column registration_id text;
create index tokens_registration on tokens(registration_id);
