import { exportJWK, generateKeyPair } from "jose";

const { privateKey } = await generateKeyPair("ES256", { extractable: true });
const jwk = await exportJWK(privateKey);
console.log(JSON.stringify({ ...jwk, kid: crypto.randomUUID() }));
