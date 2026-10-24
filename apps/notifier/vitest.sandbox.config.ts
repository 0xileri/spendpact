import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

// Runs the built notifier (dist/) against a local sandbox chain and a mock Bot API; see test/sandbox/global-setup.ts.
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
