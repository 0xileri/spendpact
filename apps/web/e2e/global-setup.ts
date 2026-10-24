import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createServer } from "vite";

const WEB = resolve(import.meta.dirname, "..");
const ROOT = resolve(WEB, "../..");
const SIGNER_PORT = 8799;
const WEB_PORT = 5199;

function waitForOutput(child: ChildProcess, marker: string, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${marker}"`)), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes(marker)) {
        clearTimeout(timer);
        resolvePromise();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`process exited with ${code} before "${marker}"`));
    });
  });
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((done) => {
    if (child.exitCode !== null) return done();
    child.once("exit", () => done());
    child.kill("SIGINT");
  });
}

export default async function globalSetup() {
  const fixturePath = join(mkdtempSync(join(tmpdir(), "spact-e2e-")), "fixture.json");

  // Builds the contracts on first run, so allow a while.
  const sandbox = spawn(join(ROOT, "scripts/start-demo-sandbox.sh"), [fixturePath], { stdio: ["ignore", "pipe", "inherit"] });
  await waitForOutput(sandbox, "READY", 900_000);
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { rpc_url: string; vault_id: string };

  const signer = spawn(process.execPath, ["--experimental-strip-types", "dev/dev-signer.ts", fixturePath], {
    cwd: WEB,
    env: { ...process.env, DEV_SIGNER_PORT: String(SIGNER_PORT) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await waitForOutput(signer, "dev signer for", 30_000);

  // Vite exposes VITE_* variables from the environment to the page.
  Object.assign(process.env, {
    SPACT_FIXTURE: fixturePath,
    VITE_NEAR_NETWORK: "sandbox",
    VITE_NEAR_RPC_URL: fixture.rpc_url,
    VITE_VAULT_ID: fixture.vault_id,
    VITE_DEV_SIGNER_URL: `http://127.0.0.1:${SIGNER_PORT}`,
  });
  const server = await createServer({
    root: WEB,
    configFile: join(WEB, "vite.config.ts"),
    server: { host: "127.0.0.1", port: WEB_PORT, strictPort: true },
    logLevel: "warn",
  });
  await server.listen();

  return async () => {
    await server.close();
    await Promise.all([stop(signer), stop(sandbox)]);
  };
}
