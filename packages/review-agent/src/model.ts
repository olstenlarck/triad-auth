import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { withOpenCodeSessionHeader } from "@earendil-works/pi-ai/providers/opencode-headers";
import { setProvider } from "@flue/runtime";

const defaultModel = "muse-spark-1.3-contributor-free";

// Turns the OpenCode Zen model id that the workflow passes in REVIEW_MODEL, with or without the
// "opencode/" prefix, into a Flue model specifier.
function resolve(spec: string): string {
  const id = spec.replace(/^opencode\//, "");
  // Zen adds free models faster than the catalog that Flue ships. A missing one is served from
  // Zen's chat completions endpoint, which all of its free models use.
  if (
    !opencodeProvider()
      .getModels()
      .some((model) => model.id === id)
  ) {
    setProvider(
      createProvider({
        id: "opencode",
        name: "OpenCode Zen",
        auth: { apiKey: envApiKeyAuth("OpenCode API key", ["OPENCODE_API_KEY"]) },
        models: [
          {
            id,
            name: id,
            api: "openai-completions",
            provider: "opencode",
            baseUrl: "https://opencode.ai/zen/v1",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 32_000,
          },
        ],
        api: withOpenCodeSessionHeader(openAICompletionsApi()),
      }),
    );
  }
  return `opencode/${id}`;
}

export const model = resolve(process.env.REVIEW_MODEL || defaultModel);
