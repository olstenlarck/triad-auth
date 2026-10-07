import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { withOpenCodeSessionHeader } from "@earendil-works/pi-ai/providers/opencode-headers";
import { setProvider } from "@flue/runtime";

const defaultModel = "opencode/muse-spark-1.3-contributor-free";

// Turns the model that the workflow passes in REVIEW_MODEL into a Flue model specifier. Workers AI
// models (any name with "@cf/") go through the review-agent Cloudflare AI Gateway. Every other
// model is an OpenCode Zen model, with or without the "opencode/" prefix.
function resolve(spec: string): string {
  const workersAI = spec.indexOf("@cf/");
  if (workersAI !== -1) {
    return `cloudflare-ai-gateway/workers-ai/${spec.slice(workersAI)}`;
  }
  if (spec.startsWith("cloudflare-ai-gateway/")) {
    return spec;
  }
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
