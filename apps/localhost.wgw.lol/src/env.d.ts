import type { RepoObject } from "./do/repo";
import type { QueueEvent } from "./events";

declare global {
  interface AppEnv {
    APP_ORIGIN: string;
    TRIAD_ISSUER: string;
    AGENTID_ISSUER: string;
    COMMIT_SHA: string;
    ASSETS: Fetcher;
    DB: D1Database;
    KV: KVNamespace;
    BLOBS: R2Bucket;
    EVENTS: Queue<QueueEvent>;
    REPOS: DurableObjectNamespace<RepoObject>;
    AI: Ai;
    ANALYTICS: AnalyticsEngineDataset;
    GIT_RATE_LIMIT: RateLimit;
    SESSION_SECRET: string;
    ENCRYPTION_KEY: string;
    JWT_PRIVATE_JWK: string;
  }

  // `env` from "cloudflare:workers" is typed as Cloudflare.Env, so this merge gives it the bindings above.
  namespace Cloudflare {
    interface Env extends AppEnv {}
  }
}
