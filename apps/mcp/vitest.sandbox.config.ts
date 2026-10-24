import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

// Spawns the built server (dist/) against a local sandbox chain; see test/sandbox/global-setup.ts.
export default defineConfig({
  ssr: { resolve: { conditions: ["spact-source", ...defaultServerConditions] } },
  test: {
    include: ["test/sandbox/*.test.ts"],
    globalSetup: ["test/sandbox/global-setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 900_000,
    fileParallelism: false,
  },
});
