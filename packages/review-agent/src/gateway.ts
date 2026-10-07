import { createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { cloudflareAIGatewayProvider } from "@earendil-works/pi-ai/providers/cloudflare-ai-gateway";
import { cloudflareStreams } from "@earendil-works/pi-ai/providers/cloudflare-stream";
import { setProvider } from "@flue/runtime";

// The built-in cloudflare-ai-gateway provider sends the Cloudflare token as Anthropic's x-api-key,
// and AI Gateway forwards a provider key to Anthropic unchanged. Unified billing and stored keys
// need the token in cf-aig-authorization instead, so this provider replaces the built-in one.
setProvider(
  createProvider({
    id: "cloudflare-ai-gateway",
    auth: {
      apiKey: {
        name: "Cloudflare AI Gateway token",
        resolve: async () => {
          const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_KEY, CLOUDFLARE_GATEWAY_ID } = process.env;
          if (!(CLOUDFLARE_ACCOUNT_ID && CLOUDFLARE_API_KEY && CLOUDFLARE_GATEWAY_ID)) {
            return;
          }
          return {
            auth: {
              headers: {
                "cf-aig-authorization": `Bearer ${CLOUDFLARE_API_KEY}`,
                "x-api-key": null,
              },
            },
            env: { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_GATEWAY_ID },
          };
        },
      },
    },
    models: cloudflareAIGatewayProvider()
      .getModels()
      .filter((model) => model.api === "anthropic-messages"),
    api: cloudflareStreams(anthropicMessagesApi()),
  }),
);

export const model = "cloudflare-ai-gateway/claude-opus-5";
