import { useEffect, useState } from "react";

import type { PaymentRequest } from "@spact/shared";

import type { AppConfig } from "../config.js";
import { errorMessage } from "../format.js";
import { listOpenRequests } from "../near/vault.js";
import { Card, Mono, Notice, StatusBadge } from "./ui.js";

/** Requests still waiting for the owner. Amounts are in base units; the approval page shows token units. */
export function PendingList({ config }: { config: AppConfig }) {
  const [requests, setRequests] = useState<PaymentRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listOpenRequests(config)
      .then(setRequests)
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [config]);

  if (error) return <Notice tone="bad" title="Could not read requests from the vault">{error}</Notice>;
  if (!requests) return <p className="text-sm text-slate-500">Reading open requests…</p>;

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Waiting for your decision</h1>
      {requests.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-600">No open requests. Payments within the auto limit never show up here.</p>
        </Card>
      ) : (
        <ul className="space-y-3" data-testid="pending-list">
          {requests.map((r) => (
            <li key={r.request_id}>
              <a
                href={`?request=${encodeURIComponent(r.request_id)}`}
                className="block rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-400 focus-visible:outline-2 focus-visible:outline-slate-700"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Mono className="text-sm font-semibold">{r.request_id}</Mono>
                  <StatusBadge status={r.status} />
                </div>
                <p className="mt-2 text-sm text-slate-700">
                  <Mono>{r.amount}</Mono> base units of <Mono>{r.token}</Mono> to <Mono className="font-semibold">{r.recipient}</Mono>
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  requested by <Mono>{r.agent_id}</Mono>
                </p>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
