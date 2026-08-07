pragma foreign_keys = off;

create table "user_new" (
  "id" text not null primary key,
  "createdAt" date not null,
  "updatedAt" date not null,
  "provider" text not null,
  "providerSub" text not null unique,
  "profileData" text
);

insert into "user_new" ("id", "createdAt", "updatedAt", "provider", "providerSub")
select "id", "createdAt", "updatedAt", "provider", "providerSub"
from "user";

drop table "user";

alter table "user_new" rename to "user";

pragma foreign_keys = on;

create table "rateLimit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);
