import type { ReactNode } from "react";

import type { Status } from "@spact/shared";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-xl border border-slate-200 bg-white p-5 shadow-sm ${className}`}>{children}</section>;
}

type Tone = "neutral" | "good" | "warn" | "bad" | "info";

const TONES: Record<Tone, string> = {
  neutral: "bg-slate-100 text-slate-700 ring-slate-200",
  good: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  warn: "bg-amber-50 text-amber-900 ring-amber-200",
  bad: "bg-rose-50 text-rose-800 ring-rose-200",
  info: "bg-sky-50 text-sky-900 ring-sky-200",
};

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${TONES[tone]}`}>{children}</span>;
}

export function Notice({ tone, title, children }: { tone: Tone; title: string; children?: ReactNode }) {
  return (
    <div className={`rounded-lg p-4 text-sm ring-1 ${TONES[tone]}`} role={tone === "bad" ? "alert" : undefined}>
      <p className="font-semibold">{title}</p>
      {children ? <div className="mt-1 leading-relaxed">{children}</div> : null}
    </div>
  );
}

const STATUS_TONE: Record<Status, Tone> = {
  BLOCKED: "bad",
  AWAITING_APPROVAL: "warn",
  APPROVED: "info",
  DENIED: "neutral",
  EXPIRED: "neutral",
  TRANSFER_PENDING: "info",
  SETTLED: "good",
  TRANSFER_FAILED: "bad",
};

const STATUS_LABEL: Record<Status, string> = {
  BLOCKED: "Blocked",
  AWAITING_APPROVAL: "Awaiting approval",
  APPROVED: "Approved",
  DENIED: "Rejected",
  EXPIRED: "Expired",
  TRANSFER_PENDING: "Transfer pending",
  SETTLED: "Paid",
  TRANSFER_FAILED: "Transfer failed",
};

export function StatusBadge({ status }: { status: Status }) {
  return (
    <span data-testid="request-status" data-status={status}>
      <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
    </span>
  );
}

export function statusLabel(status: Status): string {
  return STATUS_LABEL[status];
}

export function Field({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[10rem_1fr] sm:gap-4">
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd className="min-w-0 text-sm text-slate-900" data-testid={testId}>
        {children}
      </dd>
    </div>
  );
}

export function Mono({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono break-all ${className}`}>{children}</span>;
}

export function Button({
  children,
  onClick,
  disabled,
  variant = "primary",
  title,
  testId,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: "primary" | "danger" | "secondary";
  title?: string;
  testId?: string;
}) {
  const styles = {
    primary: "bg-emerald-700 text-white hover:bg-emerald-800 focus-visible:outline-emerald-700",
    danger: "bg-white text-rose-700 ring-1 ring-rose-300 hover:bg-rose-50 focus-visible:outline-rose-700",
    secondary: "bg-white text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50 focus-visible:outline-slate-700",
  }[variant];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-testid={testId}
      className={`inline-flex min-h-11 items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-40 ${styles}`}
    >
      {children}
    </button>
  );
}
