interface Env {
  ASSETS: Fetcher;
}

export default {
  async fetch(request, env, context) {
    if (new URL(request.url).pathname.startsWith("/__astro_")) {
      const { handle } = await import("@astrojs/cloudflare/handler");

      return handle(request, env, context);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
