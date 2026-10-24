import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Resolve workspace packages to their TypeScript sources, so no prebuild step is needed.
  ssr: { resolve: { conditions: ["spact-source", ...defaultServerConditions] } },
  test: { include: ["test/*.test.ts"] },
});
