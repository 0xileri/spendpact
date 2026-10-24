import { useCallback, useEffect, useState } from "react";

import { explainReason, type PaymentRequest, type ReasonCode, type Status } from "@spact/shared";

import { assess, buildApproveActions, buildRejectActions, reasonFromError } from "../approval.js";
import { explorerTxLink, type AppConfig } from "../config.js";
import { errorMessage, formatAmount, formatRelative, formatUtc, shortHash } from "../format.js";
import { loadSnapshot, waitForRequest, type VaultSnapshot } from "../near/vault.js";
import { SignError, type OwnerSigner } from "../signers/index.js";
import type { SignerState } from "../useSigner.js";
import { Button, Card, Field, Mono, Notice, StatusBadge, statusLabel } from "./ui.js";

type Action = "approve" | "reject";
type Phase =
  | { kind: "idle" }
  | { kind: "signing"; action: Action }
  | { kind: "confirming"; action: Action; txHash: string | null }
  | { kind: "done"; action: Action; txHash: string | null; status: Status | null }
  | { kind: "failed"; action: Action; message: string; reason: ReasonCode | null; txHash: string | null };

const FINAL_AFTER_PAY: Status[] = ["SETTLED", "TRANSFER_FAILED"];

function settledFor(action: Action, executeNow: boolean): (r: PaymentRequest) => boolean {
  if (action === "reject") return (r) => r.status === "DENIED";
  return executeNow ? (r) => FINAL_AFTER_PAY.includes(r.status) : (r) => r.status !== "AWAITING_APPROVAL";
}

export function ApprovalPage({
  config,
  requestId,
  signer,
  wallet,
}: {
  config: AppConfig;
  requestId: string;
  signer: OwnerSigner | null;
  wallet: SignerState;
}) {
  const [snapshot, setSnapshot] = useState<VaultSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [executeNow, setExecuteNow] = useState(true);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await loadSnapshot(config, requestId));
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [config, requestId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loadError) {
    return (
      <Notice tone="bad" title="Could not read this request from the chain">
        <p>{loadError}</p>
        <p className="mt-2">Nothing was signed. Check the RPC endpoint and try again.</p>
      </Notice>
    );
  }
  if (!snapshot) return <p className="text-sm text-slate-500">Reading the request from the vault…</p>;

  const a = assess({ config, snapshot, signerAvailable: signer !== null, signerAccountId: wallet.accountId, executeNow });
  const { request, token, budget, policy } = snapshot;
  const busy = phase.kind === "signing" || phase.kind === "confirming";

  async function decide(action: Action) {
    if (!signer || !request) return;
    const hash = a.computedHash;
    if (action === "approve" && !hash) return;
    const actions = action === "approve" && hash ? buildApproveActions(requestId, hash, executeNow) : buildRejectActions(requestId);
    setPhase({ kind: "signing", action });
    try {
      const { txHash } = await signer.signAndSend(config.vaultId, actions);
      setPhase({ kind: "confirming", action, txHash });
      const final = await waitForRequest(config, requestId, settledFor(action, executeNow));
      await refresh();
      setPhase({ kind: "done", action, txHash, status: final?.status ?? null });
    } catch (e) {
      const message = errorMessage(e);
      await refresh();
      setPhase({ kind: "failed", action, message, reason: reasonFromError(message), txHash: e instanceof SignError ? e.txHash : null });
    }
  }

  const tokenPolicy = request ? policy.tokens.find((t) => t.token === request.token) : undefined;
  const blocking = a.problems.filter((p) => p.blocksApprove || p.blocksReject);
  const warnings = a.problems.filter((p) => !p.blocksApprove && !p.blocksReject);
  const approveLabel = executeNow ? "Approve and pay" : "Approve only";

  return (
    <div className="space-y-5">
      {request ? (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h1 className="text-sm font-medium text-slate-500">Payment request</h1>
            <StatusBadge status={request.status} />
          </div>
          <p className="mt-3 text-3xl font-semibold tracking-tight" data-testid="amount">
            {formatAmount(request.amount, token)}
          </p>
          <p className="mt-1 text-sm text-slate-600">to</p>
          <p className="mt-1 text-xl font-semibold" data-testid="recipient">
            <Mono>{request.recipient}</Mono>
          </p>

          <dl className="mt-4 divide-y divide-slate-100 border-t border-slate-100">
            <Field label="Amount in base units">
              <Mono>{request.amount}</Mono>
            </Field>
            <Field label="Token contract">
              <Mono>{request.token}</Mono>
            </Field>
            <Field label="Requested by">
              <Mono>{request.agent_id}</Mono>
            </Field>
            <Field label="Agent's note" testId="reason">
              {request.reason ? (
                <>
                  <q className="text-slate-800">{request.reason}</q>
                  <span className="mt-1 block text-xs text-slate-500">Written by the agent. Not verified.</span>
                </>
              ) : (
                <span className="text-slate-400">none</span>
              )}
            </Field>
            <Field label="Expires">
              {formatUtc(request.expires_at_ns)}
              {a.expiresInSec !== null ? <span className="text-slate-500"> ({formatRelative(a.expiresInSec)})</span> : null}
            </Field>
            <Field label="Request ID">
              <Mono>{request.request_id}</Mono>
            </Field>
          </dl>
        </Card>
      ) : null}

      {request && tokenPolicy ? (
        <Card>
          <h2 className="text-sm font-semibold text-slate-700">Vault policy for this token</h2>
          <dl className="mt-2 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-slate-500">Paid without asking</dt>
              <dd className="font-medium">up to {formatAmount(tokenPolicy.auto_limit, token)}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Largest single payment</dt>
              <dd className="font-medium">{formatAmount(tokenPolicy.hard_tx_limit, token)}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Left today (UTC)</dt>
              <dd className="font-medium" data-testid="budget-left">
                {budget ? `${formatAmount(budget.available, token)} of ${formatAmount(budget.daily_limit, token)}` : "unknown"}
              </dd>
            </div>
          </dl>
        </Card>
      ) : null}

      {request && a.computedHash ? (
        a.hashMatches ? (
          <div data-testid="hash-check" data-ok="true">
            <Notice tone="good" title="Hash check passed">
              <p>
                The terms above hash to <Mono>{shortHash(a.computedHash)}</Mono> in your browser, the same value the vault stored. Your approval
                signs this hash, so the vault rejects it if the stored request differs in any way.
              </p>
            </Notice>
          </div>
        ) : (
          <div data-testid="hash-check" data-ok="false">
            <Notice tone="bad" title="Hash check failed: do not approve">
              <p>
                These terms hash to <Mono>{shortHash(a.computedHash)}</Mono>, but the vault stores <Mono>{shortHash(request.request_hash)}</Mono>.
                What you see may have been altered on its way to you.
              </p>
            </Notice>
          </div>
        )
      ) : null}

      {blocking.length > 0 ? (
        <div className="space-y-2" data-testid="problems">
          {blocking.map((p) => (
            <Notice key={p.code} tone={p.code === "NOT_CONNECTED" ? "info" : p.code === "NOT_OPEN" ? "neutral" : "warn"} title={p.message} />
          ))}
        </div>
      ) : null}
      {warnings.map((p) => (
        <Notice key={p.code} tone="neutral" title={p.message} />
      ))}

      {request && (request.status === "AWAITING_APPROVAL" || request.status === "APPROVED") ? (
        <Card>
          <h2 className="text-sm font-semibold text-slate-700">Your decision</h2>
          {request.status === "AWAITING_APPROVAL" ? (
            <label className="mt-3 flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-emerald-700"
                checked={executeNow}
                onChange={(e) => setExecuteNow(e.target.checked)}
                disabled={busy}
                data-testid="execute-now"
              />
              <span>
                Pay immediately after approving
                <span className="block text-slate-500">Otherwise the agent can execute it later, until it expires.</span>
              </span>
            </label>
          ) : null}
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            {wallet.accountId === null && signer ? (
              <Button onClick={() => void wallet.connect()} disabled={wallet.busy} variant="secondary" testId="connect-inline">
                Connect owner wallet
              </Button>
            ) : null}
            {request.status === "AWAITING_APPROVAL" ? (
              <Button onClick={() => void decide("approve")} disabled={!a.canApprove || busy} testId="approve">
                {approveLabel}
              </Button>
            ) : null}
            <Button onClick={() => void decide("reject")} disabled={!a.canReject || busy} variant="danger" testId="reject">
              Reject
            </Button>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Approving and rejecting attach 1 yoctoNEAR, so your wallet must confirm with a full-access key. A limited key held by an app cannot do
            this.
          </p>
        </Card>
      ) : null}

      <div aria-live="polite" data-testid="phase" data-phase={phase.kind}>
        <PhaseView phase={phase} config={config} />
      </div>
    </div>
  );
}

function TxLink({ config, txHash }: { config: AppConfig; txHash: string | null }) {
  if (!txHash) return null;
  const href = explorerTxLink(config, txHash);
  return (
    <p className="mt-1">
      Transaction{" "}
      {href ? (
        <a className="font-mono underline" href={href} target="_blank" rel="noreferrer">
          {shortHash(txHash)}
        </a>
      ) : (
        <Mono>{txHash}</Mono>
      )}
    </p>
  );
}

function PhaseView({ phase, config }: { phase: Phase; config: AppConfig }) {
  switch (phase.kind) {
    case "idle":
      return null;
    case "signing":
      return <Notice tone="info" title="Waiting for your wallet to sign…" />;
    case "confirming":
      return (
        <Notice tone="info" title="Submitted. Waiting for the vault to confirm on chain…">
          <TxLink config={config} txHash={phase.txHash} />
        </Notice>
      );
    case "done": {
      const s = phase.status;
      const title =
        s === "SETTLED"
          ? "Confirmed on chain: approved and paid"
          : s === "APPROVED"
            ? "Confirmed on chain: approved. The agent can now execute it."
            : s === "DENIED"
              ? "Confirmed on chain: rejected"
              : s === "TRANSFER_FAILED"
                ? "Approved, but the token transfer failed. The reserved budget was released."
                : `Submitted, but not confirmed yet${s ? ` (vault reports: ${statusLabel(s)})` : ""}. Refresh in a moment.`;
      const tone = s === "SETTLED" || s === "APPROVED" || s === "DENIED" ? "good" : "warn";
      return (
        <Notice tone={tone} title={title}>
          <TxLink config={config} txHash={phase.txHash} />
        </Notice>
      );
    }
    case "failed":
      return (
        <Notice tone="bad" title={phase.reason ? `The vault refused: ${phase.reason}` : "The transaction did not go through"}>
          <p>{phase.reason ? explainReason(phase.reason) : phase.message}</p>
          <p className="mt-1">Nothing changed on chain except gas fees, if any.</p>
          <TxLink config={config} txHash={phase.txHash} />
        </Notice>
      );
  }
}
