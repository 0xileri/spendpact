/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defaultServerConditions, defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Resolve workspace packages to their TypeScript sources, so no prebuild step is needed.
  resolve: { conditions: ["spact-source", ...defaultClientConditions] },
  // Vitest runs in the server environment, which has its own resolve conditions.
  ssr: { resolve: { conditions: ["spact-source", ...defaultServerConditions] } },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
