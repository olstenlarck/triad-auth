ALTER TABLE "user" ADD COLUMN "profileEmail" text;
ALTER TABLE "user" ADD COLUMN "profileEmailVerified" integer;
ALTER TABLE "user" ADD COLUMN "profileHandle" text;
ALTER TABLE "user" ADD COLUMN "profileDisplayName" text;
ALTER TABLE "user" ADD COLUMN "profileAvatar" text;

CREATE TABLE "deviceCode" (
  "id" text NOT NULL PRIMARY KEY,
  "deviceCode" text NOT NULL,
  "userCode" text NOT NULL,
  "userId" text,
  "expiresAt" date NOT NULL,
  "status" text NOT NULL,
  "lastPolledAt" date,
  "pollingInterval" integer,
  "clientId" text,
  "scope" text
);
