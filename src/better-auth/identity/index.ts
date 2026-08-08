export { createIdentityConfiguration } from "./configuration";
export { openEncryptedData, sealEncryptedData, validateEncryptionSecrets } from "./encryption";
export { createPasskeyAuthentication } from "./passkey";
export {
  canonicalPasskeyUsername,
  createPasskeyUsernameGenerator,
  normalizePasskeyUsername,
  passkeyAccountSubject,
  passkeyAccountSubjectFromUserHandle,
  passkeyDisplayName,
  type PasskeyUsernameGeneratorOptions,
  passkeyWebAuthnUserId,
} from "./passkey-username";
export {
  type CapturedProfile,
  captureProviderProfile,
  createProfileClaimResolver,
  type ProfileClaims,
  openProfileEncryptedData,
  sealProfileEncryptedData,
  type ProfileIdentityUser,
} from "./profile";
export { createEthereumAuthentication } from "./siwe";
export { createSessionClaimResolver } from "./session";
export {
  accountSubject,
  type AuthenticationProvider,
  ethereumUpstreamId,
  type IdentityProvider,
  pairwiseSubject,
  passkeyUpstreamId,
  providerSubject,
  sha256Hex,
} from "./subjects";
