import type { InferEnv, UnwrapConfig } from "cf/config";

import type config from "../../cloudflare.config";
import type { Repo } from "./repo-object";

// Bindings are inferred from cloudflare.config.ts, so the config is the single source of truth.
type WorkerConfig = UnwrapConfig<UnwrapConfig<typeof config>["worker"]>;

export type Env = Omit<InferEnv<WorkerConfig>, "REPO"> & { REPO: DurableObjectNamespace<Repo> };
