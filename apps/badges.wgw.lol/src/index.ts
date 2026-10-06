import { liveLayer, makeWorker } from "./badges";
import type { Env } from "./env";

export default makeWorker(liveLayer) satisfies ExportedHandler<Env>;
