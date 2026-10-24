# Architecture

Status labels: **built** (code plus passing tests in this repo), **planned** (in AGENTS.md, no code yet).

```text
                    HUMAN OWNER  (NEAR wallet, full-access key)
                         | set_policy / set_paused / approve_request(id, hash)
                         | reject_request / owner_withdraw        [built, contract side]
                         v
 AI AGENT --request_direct_payment / execute_request--> SPACT VAULT (Rust, near-sdk)  [built]
 (own NEAR account,                                     - policy + version
  restricted key)                                       - immutable requests + hash
                                                        - UTC-day ledger: executed + pending
                                                        - single dispatch point
                                                             |
                                          ft_transfer (1 yocto) | then on_transfer_result (#[private])
                                                             v
                                                    NEP-141 token contract
                                                             |
                                                         recipient

 OWNER BROWSER: approval page (apps/web) [built]
   reads vault + token over NEAR RPC -> hashes displayed terms -> wallet signs approve_request(id, hash)

 AGENT HOST (Claude Code, Codex): MCP server (apps/mcp) [built]
   request_payment / get_payment_status -> signs with the agent's function-call key

 OWNER PHONE: Telegram notifier (apps/notifier) [built]
   polls the vault -> plain-text alert with the exact terms + approval link -> follow-up when paid

 planned: API/indexer, 1Click adapter (P1)
```

## Vault contract (`contracts/spact-vault`) [built]

**State:** owner, network label, agents (max 8), paused flag, policy (tokens, recipient allowlist, limits), `policy_version`, open-approval counter, requests (`IterableMap<String, PaymentRequest>`), ledgers keyed by `(token, utc_day)`, stored-request counts per day.

**Request lifecycle**

```text
request_direct_payment (agent)
  |-- policy check fails ----------------------------> BLOCKED (returned + event, not stored)
  |-- amount <= auto_limit --> reserve + ft_transfer --> TRANSFER_PENDING
  '-- amount >  auto_limit ---------------------------> AWAITING_APPROVAL
AWAITING_APPROVAL --approve_request(id, hash) by owner--> APPROVED
AWAITING_APPROVAL | APPROVED --reject_request by owner--> DENIED
AWAITING_APPROVAL | APPROVED --expire_request after TTL--> EXPIRED
APPROVED --execute_request (owner or agent), rechecks--> reserve + ft_transfer --> TRANSFER_PENDING
TRANSFER_PENDING --callback: transfer ok-----> SETTLED          (pending -> executed)
TRANSFER_PENDING --callback: transfer failed-> TRANSFER_FAILED  (pending released)
```

The spec's AUTO_AUTHORIZED, RESERVED and SOURCE_CONFIRMED states happen inside one receipt, so they are never observable and not stored (ADR-007).

**Checks for a new request, in order:** paused, request id format, duplicate id, amount > 0, reason (at most 256 bytes, no control characters), token in policy, recipient allowlisted, amount <= hard cap, amount <= today's available budget, open-approval cap (approval path only), stored-requests-per-day cap.

**Execution rechecks:** caller is the owner or the requesting agent, status is APPROVED, not paused, policy version unchanged, not expired, agent still allowed, budget available.

**Budget:** `available = daily_limit - (executed + pending)` for `(token, floor(block_timestamp / 1 day))`. Reservation happens in `dispatch`, the only place a payment transfer is created, before the promise is sent. The callback moves the amount from pending to executed on success, or releases it on failure. It does this only if the request is still TRANSFER_PENDING, so it runs at most once, and always on the day recorded at dispatch.

**Request hash:** sha256 over a versioned, borsh-compatible encoding of domain, network, vault id, request id, agent, route, token, amount, recipient, reason, expiry and policy version (`src/digest.rs`, mirrored in `packages/shared/src/digest.ts`).

**Events:** NEP-297 `EVENT_JSON` with standard `spact` for policy, pause, agent changes, blocked requests, status transitions and owner withdrawals. Indexers read events; contract state is the source of truth.

## Mock token (`contracts/mock-ft`) [built, test only]

A wrapper around `near-contract-standards` `FungibleToken`. It exists so tests use real NEP-141 semantics: storage registration, 1 yocto on transfer, and a failed transfer to an unregistered account.

## Shared TS package (`packages/shared`) [built]

Contract JSON types, reason codes with user-facing text, exact BigInt amount parsing, and the request digest. This is what the approval page will use to hash the terms it displays.

## Approval page (`apps/web`) [built]

React 19 + Vite 8 + Tailwind 4. No backend: it reads the vault directly over NEAR JSON-RPC (`get_config`, `get_policy`, `get_request`, `get_budget`, token `ft_metadata`, latest final block time) and validates every response with the zod schemas in `@spact/shared`.

```text
?request=<id>  -> loadSnapshot -> assess():
                    vault id + network match this deployment's config
                    request open, not expired, same policy version
                    hash(displayed terms, configured network, configured vault) == stored hash
                    connected account == vault owner
                    (pay now) not paused, enough budget left today
               -> signer.signAndSend(vault, [approve_request(id, hash) + 1 yocto, execute_request(id)?])
               -> poll get_request until the chain shows the result; only then report success
```

- **Signers.** testnet/mainnet: `@hot-labs/near-connect` (wallets run in sandboxed iframes). sandbox: `dev/dev-signer.ts`, a localhost process holding the sandbox owner key that signs only approve/reject/execute on the demo vault.
- **Routes.** `/` lists open requests; `/?request=<id>` is the approval page (the Telegram deep link target). A `vault=` parameter that differs from the configured vault is refused.
- **Local demo.** `scripts/dev-sandbox.sh` runs `demo-sandbox` (a Rust binary in `contracts/integration-tests` that deploys a funded vault on a local node), the dev signer and the dev server.
- **Browser tests.** `apps/web/e2e`, Playwright + Chromium against that same local setup.

## MCP server (`apps/mcp`) [built]

A local stdio server for the agent's host, on `@modelcontextprotocol/server` 2.3.1 (ADR-018). Two tools:

```text
request_payment(token, amount_units, recipient, reason, request_id)
  -> validate input (same rules as the vault)
  -> preflight: view_access_key is a function-call key for the vault, limited to the agent methods;
                get_config network and agent list match
  -> sign request_direct_payment with that key, wait for FINAL
  -> {policy_decision, onchain_status, reason_code, explanation, tx_hash, review_url?}
get_payment_status(request_id)
  -> get_request + final block time -> {source_status | NOT_FOUND, reason_code, expiry by chain time}
```

The same preflight runs at startup, and the server exits if it fails. Tool results use fixed sentences; the agent's `reason` text is never echoed back.

## Telegram notifier (`apps/notifier`) [built]

A Node process with no NEAR keys and no webhook (ADR-020).

```text
every SPACT_POLL_SECONDS:
  count = get_config.request_count; fresh = list_requests(newest count - seen); recheck count
  for each fresh request, oldest first: AWAITING_APPROVAL and not expired by chain time -> alert
  for each alerted open request: status changed -> follow-up (paid / rejected / expired / failed)
link once: print a code on the terminal -> getUpdates until "/start <code>" from a private chat
```

The Bot API client validates every reply, waits for `retry_after` on 429, and never puts the bot token (part of the URL) in an error.

## Planned (not built)

| Component | Role | Authority |
|---|---|---|
| Dashboard and Security Lab view | policy, history, test results | none: the owner's wallet signs |
| API (Hono on Workers) | relay agent requests, index events, send notifications | none: on-chain state wins |
| 1Click adapter (P1) | quote and owner-approved cross-chain route | trusted off-chain quote, disclosed |
