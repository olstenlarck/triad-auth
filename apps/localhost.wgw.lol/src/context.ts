import { env } from "cloudflare:workers";

import type { Principal } from "./auth";
import { Db } from "./db";
import type { RepoObject } from "./do/repo";

export function appEnv(): AppEnv {
  return env;
}

export function db(): Db {
  return new Db(appEnv().DB);
}

export function repoStub(repoId: string): DurableObjectStub<RepoObject> {
  const bindings = appEnv();

  return bindings.REPOS.get(bindings.REPOS.idFromName(repoId));
}

export function personFor(principal: Principal): {
  name: string;
  email: string;
  time: number;
  tz: string;
} {
  return {
    name: principal.user.display_name || principal.user.handle,
    email: `${principal.user.handle}@users.localhost.wgw.lol`,
    time: Math.floor(Date.now() / 1000),
    tz: "+0000",
  };
}
