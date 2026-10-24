import { useMemo } from "react";

import { ApprovalPage } from "./components/ApprovalPage.js";
import { PendingList } from "./components/PendingList.js";
import { Badge, Button, Mono, Notice } from "./components/ui.js";
import type { AppConfig, NetworkId } from "./config.js";
import { createSigner } from "./signers/index.js";
import { useSigner } from "./useSigner.js";

const NETWORK_BADGE: Record<NetworkId, { tone: "neutral" | "warn" | "bad"; label: string }> = {
  sandbox: { tone: "neutral", label: "Local sandbox" },
  testnet: { tone: "warn", label: "Testnet" },
  mainnet: { tone: "bad", label: "Mainnet: real funds" },
};

export function App({ config }: { config: AppConfig }) {
  const signer = useMemo(() => createSigner(config), [config]);
  const wallet = useSigner(signer);
  const params = new URLSearchParams(window.location.search);
  const requestId = params.get("request");
  const linkVault = params.get("vault");
  const badge = NETWORK_BADGE[config.network];

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col px-4 py-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <a href="./" className="text-lg font-bold tracking-tight">
            Spact
          </a>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <Badge tone={badge.tone}>{badge.label}</Badge>
            <span>
              vault <Mono>{config.vaultId}</Mono>
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2" data-testid="wallet">
          {signer === null ? (
            <span className="text-xs text-slate-500">No signer configured</span>
          ) : wallet.accountId ? (
            <>
              <Mono className="text-sm" >{wallet.accountId}</Mono>
              <Button onClick={() => void wallet.disconnect()} variant="secondary" disabled={wallet.busy}>
                Disconnect
              </Button>
            </>
          ) : (
            <Button onClick={() => void wallet.connect()} variant="secondary" disabled={wallet.busy} testId="connect">
              {wallet.busy ? "Connecting…" : `Connect ${signer.label}`}
            </Button>
          )}
        </div>
      </header>

      <main className="flex-1">
        {wallet.error ? (
          <div className="mb-4">
            <Notice tone="bad" title="Wallet error">
              {wallet.error}
            </Notice>
          </div>
        ) : null}
        {linkVault !== null && linkVault !== config.vaultId ? (
          <Notice tone="bad" title="This link is for a different vault">
            <p>
              The link names <Mono>{linkVault}</Mono>, but this page only approves payments for <Mono>{config.vaultId}</Mono>. Nothing was loaded.
            </p>
          </Notice>
        ) : requestId ? (
          <ApprovalPage config={config} requestId={requestId} signer={signer} wallet={wallet} />
        ) : (
          <PendingList config={config} />
        )}
      </main>

      <footer className="mt-10 border-t border-slate-200 pt-4 text-xs leading-relaxed text-slate-500">
        Unaudited hackathon prototype. This page never holds keys: your wallet signs, and the vault contract enforces the rules.
      </footer>
    </div>
  );
}
