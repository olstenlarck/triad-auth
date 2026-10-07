import type { Env } from "./env";
import { liveLayer, makeWorker } from "./worker";

export default makeWorker(liveLayer) satisfies ExportedHandler<Env>;
