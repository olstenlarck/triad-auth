import type * as Cloudflare from "alchemy/Cloudflare";

import type { Worker } from "../alchemy.run";

// Bindings are inferred from alchemy.run.ts, so the stack is the single source of truth.
export type Env = Cloudflare.InferEnv<typeof Worker>;
