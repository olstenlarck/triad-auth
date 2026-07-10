export type ProviderName = "github";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ISSUER: string;
  SIGNING_PRIVATE_JWK: string;
  PAIRWISE_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  X_CLIENT_ID: string;
  X_CLIENT_SECRET: string;
}

export interface ClientRow {
  client_id: string;
  name: string;
  redirect_uris: string;
  providers: string;
}

export interface TransactionRow {
  state_hash: string;
  kind: "authorization_code" | "device" | "session";
  client_id: string;
  redirect_uri: string | null;
  app_state: string | null;
  provider: ProviderName;
  code_challenge: string | null;
  provider_verifier: string | null;
  provider_nonce: string | null;
  device_code_hash: string | null;
  expires_at: number;
}

export interface ProviderIdentity {
  provider: ProviderName;
  id: string;
}
