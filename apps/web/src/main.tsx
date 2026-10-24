import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { ConfigError, parseConfig } from "./config.js";
import "./index.css";

const root = createRoot(document.getElementById("root") as HTMLElement);

try {
  const config = parseConfig(import.meta.env as Record<string, string | undefined>);
  root.render(
    <StrictMode>
      <App config={config} />
    </StrictMode>,
  );
} catch (e) {
  const message = e instanceof ConfigError ? e.message : String(e);
  root.render(
    <main className="mx-auto max-w-2xl p-6">
      <h1 className="text-lg font-semibold">Spact is not configured</h1>
      <p className="mt-2 text-sm text-rose-700">{message}</p>
      <p className="mt-2 text-sm text-slate-600">See apps/web/.env.example.</p>
    </main>,
  );
}
