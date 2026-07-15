import { deviceAuthorization } from "better-auth/plugins";

export const DEVICE_AUTHORIZATION_EXPIRES_IN = "10m" as const;
export const DEVICE_AUTHORIZATION_INTERVAL = "5s" as const;
export const DEVICE_AUTHORIZATION_VERIFICATION_URI = "/device/verify/";

export function createTriadDeviceAuthorization(authOrigin: string) {
  const clientId = new URL(authOrigin).origin;

  return deviceAuthorization({
    expiresIn: DEVICE_AUTHORIZATION_EXPIRES_IN,
    interval: DEVICE_AUTHORIZATION_INTERVAL,
    verificationUri: DEVICE_AUTHORIZATION_VERIFICATION_URI,
    validateClient: async (candidate) => candidate === clientId,
  });
}

export type TriadDeviceAuthorizationPlugin = ReturnType<typeof createTriadDeviceAuthorization>;
