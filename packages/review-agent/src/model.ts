import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { setProvider } from "@flue/runtime";

const defaultModel = "nvidia/nemotron-3-ultra-550b-a55b:free";

// Turns the OpenRouter model id that the workflow passes in REVIEW_MODEL, with or without the
// "openrouter/" prefix, into a Flue model specifier.
function resolve(spec: string): string {
  const id = spec.replace(/^openrouter\//, "");
  // OpenRouter adds models faster than the catalog that Flue ships. A missing one is served from
  // OpenRouter's chat completions endpoint, which all of its models support.
  if (
    !openrouterProvider()
      .getModels()
      .some((model) => model.id === id)
  ) {
    setProvider(
      createProvider({
        id: "openrouter",
        name: "OpenRouter",
        auth: { apiKey: envApiKeyAuth("OpenRouter API key", ["OPENROUTER_API_KEY"]) },
        models: [
          {
            id,
            name: id,
            api: "openai-completions",
            provider: "openrouter",
            baseUrl: "https://openrouter.ai/api/v1",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 32_000,
          },
        ],
        api: openAICompletionsApi(),
      }),
    );
  }
  return `openrouter/${id}`;
}

export const model = resolve(process.env.REVIEW_MODEL || defaultModel);
