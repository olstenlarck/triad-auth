import { createCimdClientDiscovery, type CimdAdmissionDependencies } from "./cimd";
import { createPublicDcrOptions } from "./dcr";

export * from "./cimd";
export * from "./dcr";

export interface ClientAdmissionEnv {
  AUTH_ORIGIN: string;
}

export function createClientAdmissionFragment(
  env: ClientAdmissionEnv,
  dependencies: CimdAdmissionDependencies = {},
) {
  const clientDiscovery = createCimdClientDiscovery(env.AUTH_ORIGIN, dependencies);

  return {
    oauthProvider: {
      ...createPublicDcrOptions(),
      extensions: [{ clientDiscovery }],
    },
  };
}
