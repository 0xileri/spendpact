# Threat model

Unaudited hackathon prototype. This file maps each invariant from AGENTS.md section 3 to where it is enforced and which test shows it. An invariant without a passing test is listed as **not demonstrated**.

## Invariants

| ID | Invariant | Enforcement point | Evidence | State |
|---|---|---|---|---|
| I1 | Funds sit in the vault; the agent has no vault key | Vault is its own account. The agent signs with a function-call key on its own account that only reaches the vault's `request_direct_payment` and `execute_request` (ADR-017) | sandbox `t18_agent_cannot_move_funds_outside_policy`, `t19_restricted_agent_key_can_only_request_and_execute`, `t20_agent_key_allowance_caps_gas_spending`; `scripts/rehearse-deploy-sandbox.sh` checks the key the deploy script creates; the MCP server refuses to start with a full-access key (`apps/mcp` sandbox test `refuses to run with a full-access key`) | demonstrated (sandbox); **testnet not yet** |
| I2 | Only the owner changes policy, pauses or approves | `assert_owner`: predecessor == owner and exactly 1 yocto attached | unit `t05_*`; sandbox `t18_*`, `s2_*` | demonstrated |
| I3 | Payment terms are immutable and bound to the approval | No mutation method exists; `approve_request` recomputes the hash and requires a match | unit `t02_*`; sandbox `s2_*` (wrong hash) | demonstrated |
| I4 | No replay | Unique id per vault; execution requires APPROVED; dispatch moves the request out of it | unit `t03_*`; sandbox `s2_*` | demonstrated |
| I5 | Policy enforced on-chain | `check_new_request` and the `execute_request` rechecks | unit `t01`, `t11`, `t12`, pause tests | demonstrated |
| I6 | Budget counts executed + in-flight | `dispatch` reserves before the promise; private callback settles once | unit `t04`, `t08`, `t10`, `t17`; sandbox `t04_parallel_*`, `t08_*` | demonstrated |
| I7 | A human approves the exact request with a wallet | 1 yocto rules out function-call keys; hash binding; single use; expiry; the approval page hashes the terms it displays | sandbox `s2_*` (`DepositWithFunctionCall`); unit `t07_*`; browser e2e `forged terms with a matching forged hash are refused by the vault` | demonstrated on sandbox; **real-wallet signing on testnet not yet shown** |
| I8 | Cross-chain honesty | No cross-chain route exists (`Route::NearDirect` only) | n/a | P1 not started |
| I9 | Refund honesty | No cross-chain route exists | n/a | P1 not started |
| I10 | Fail closed | Upfront gas check; every failure path panics or returns BLOCKED before state changes | unit `request_without_enough_gas_*`; sandbox `t08_*` | demonstrated for the paths that exist |
| I11 | Auditability | NEP-297 events for every transition; reason codes on requests | unit `t01_*` checks the blocked event | events emitted; **no indexer yet** |
| I12 | No silent admin bypass | `owner_withdraw` is owner-only, 1 yocto, emits an event | unit `t05_agent_cannot_withdraw`, `owner_withdraw_*`; sandbox `pause_blocks_*` | demonstrated |

## Security Lab coverage (AGENTS.md section 10)

| Test | Case | Unit | Sandbox / browser |
|---|---|---|---|
| T01 | over hard cap | yes | yes |
| T02 | change recipient or amount after approval | yes | wrong hash: yes; browser e2e: altered RPC data is flagged, and a forged consistent hash is refused by the vault |
| T03 | replay | yes | yes |
| T04 | parallel split against the daily budget | sequential | parallel txs: yes |
| T05 | agent calls owner methods | yes | yes |
| T06 | forged Telegram callback | n/a: the bot has no buttons that act | notifier sandbox test: a forged `callback_query` "approve" is ignored and the request stays AWAITING_APPROVAL; a group chat and a wrong code cannot bind |
| T07 | expired approval | yes | no |
| T08 | transfer fails / recipient not registered | yes | yes |
| T09 | pause before execution | yes | pause blocks new requests: yes |
| T10 | UTC midnight | yes (mocked clock) | no (sandbox clock not controllable) |
| T11 | bad decimals, zero, overflow | yes + TS `parseUnits` | no |
| T12 | unlisted token or recipient | yes | recipient: yes |
| T13 | refund reported but not received | P1 | P1 |
| T14 | quote deposit address differs from payee | P1 | P1 |
| T15 | wrong vault, network or policy version | yes | no |
| T16 | direct call to the private callback | cannot be unit tested | yes |
| T17 | retries never transfer twice | repeated callbacks: yes | no |
| T18 | prompt-injected agent | n/a | agent key cannot bypass policy, and cannot call any other method or contract, move NEAR, add keys or delete the account: yes. Through the MCP server, a request whose reason claims the owner approved an unlisted account is BLOCKED with `RECIPIENT_NOT_ALLOWED` and that account receives nothing (`apps/mcp` sandbox test `T18`). No LLM in the loop yet. |

## Known limitations and trust assumptions

- **Vault account key.** Whoever holds a full-access key to the vault account can redeploy the code and bypass every rule. For the demo the owner must hold it offline. Deleting the keys after deployment would lock the code permanently. Not decided (open question in DECISIONS.md).
- **Agent operator key.** On testnet the agent account keeps its full-access key in the operator's keychain; only the agent runtime gets the function-call key (ADR-017). Whoever holds the full-access key controls the agent account and its NEAR, but still cannot move vault funds outside policy (I1, I2).
- **Agent gas allowance.** The function-call key's allowance limits gas, not payments. A runaway agent can burn it with requests the vault blocks (blocked requests are not stored, so this costs the vault nothing). When it runs out the key stops working (sandbox `t20_*`), and only a full-access key can add a new one (`t19_*` shows the function-call key cannot).
- **MCP host.** Anyone who can read the agent's key file, or drive the MCP host, can make requests as the agent. They are still bound by the vault policy and the key's gas allowance. The server only accepts a key file that other users cannot read.
- **Telegram binding** proves control of the machine running the notifier (it prints the code), not of the owner wallet (ADR-020). Whoever holds the bot token can read alerts and send messages as the bot. Neither can approve: approval is a wallet signature on the exact stored hash.
- **Agent text in alerts.** The agent's note is shown in the Telegram alert, labeled as the agent's, with links defanged so the approval page is the only link (notifier tests). It can still try social engineering in words.
- **Owner wallet compromise** defeats everything. Out of scope, as AGENTS.md says.
- **Allowlisted token contracts are trusted** to implement `ft_transfer` honestly and synchronously. A malicious token could report success without moving funds.
- **Stuck reservation.** If the callback itself fails (it has 10 Tgas of static gas), the request stays TRANSFER_PENDING and its budget stays reserved. That fails closed, but there is no reconciliation method yet.
- **Storage is paid by the vault.** Agents cannot attach deposits with function-call keys, so the vault pays storage for every stored request (bytes per request not measured yet). This is bounded by `max_requests_per_day` and `max_open_approvals`, but it never shrinks; there is no pruning yet.
- **Open approvals survive policy changes** until they are rejected or expire, and they count toward `max_open_approvals`.
- **The daily window is the UTC calendar day.** An agent can spend the full budget just before midnight and again just after. This is not a rolling 24-hour limit.
- **Request reason text** is chosen by the agent and shown to the owner. It is covered by the hash, but it can still be used for social engineering. The UI must label it as agent-supplied.
- **Blocked requests are not stored.** They exist only as events and return values.

## Approval page (apps/web)

The page reads the vault straight from a NEAR RPC endpoint and treats every response as untrusted (zod schemas in `@spact/shared`).

- **What a lying RPC can do:** show wrong terms, a wrong status or wrong balances. It cannot make the owner approve different terms. The page hashes the terms it displays together with the network and vault id it is configured for, and the owner signs that hash. If the RPC also forges the hash, the vault compares it to what it stored and refuses with `HASH_MISMATCH`. Both cases are covered by browser tests that rewrite RPC responses in flight.
- **What it can still do:** make the owner reject a legitimate request, or wait on a payment that was never made. Shown status is only as good as the RPC; use a trusted endpoint.
- **Links for other vaults are refused.** The vault id comes from the build config, never from the URL.
- **Wallets run in near-connect's sandboxed iframes.** The page never sees a key. The wallet code and manifest come from third parties (raw.githubusercontent.com, wallet hosts); that is a supply-chain dependency.
- **The dev signer** (`apps/web/dev/dev-signer.ts`) holds the sandbox owner key and signs approve/reject/execute calls for the demo vault. It binds to 127.0.0.1, refuses to start unless the RPC is local, and the page refuses it on testnet and mainnet. It must never be pointed at a real network.
- **Not done:** Content-Security-Policy and frame-ancestors headers depend on the host and are not set yet; clickjacking protection is therefore missing.
