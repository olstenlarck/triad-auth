import { bindings, defineConfig, exports } from "cf/config";

export default defineConfig({
  worker: {
    name: "ncr-floor",
    compatibilityDate: "2026-09-30",
    // The Agents SDK and Pi need Node built-ins.
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/index.ts",
    observability: { enabled: true },
    env: {
      // Workers AI has no local simulator, so `cf dev` calls the real service.
      AI: bindings.ai({ dev: { remote: true } }),
      NcrFloor: bindings.durableObject({ worker: "ncr-floor", exportName: "NcrFloor" }),
    },
    exports: {
      // PiHarness keeps Pi's tables in the object's SQLite database.
      NcrFloor: exports.durableObject({ storage: "sqlite" }),
    },
  },
});
