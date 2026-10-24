# Status

Last updated 2026-10-24 (UTC). Network mode so far: **local sandbox only**. Nothing has been deployed to testnet or mainnet, and no real funds have moved.

## Milestone: AGENTS.md section 19 steps 1-5

| Step | State |
|---|---|
| 1. Verify rules and SDKs, write INTEGRATIONS.md | done; `HACKATHON.md` added from the owner's copy (live version not fetched) |
| 2. ARCHITECTURE, THREAT_MODEL, DECISIONS, STATUS | done |
| 3. Monorepo with lint/typecheck/test/build baseline | done (pnpm + cargo workspaces, CI workflow) |
| 4. Vault with owner/agent auth and policy validation, negative tests | done |
| 5. Mock NEP-141 + sandbox direct payment; reservation, failure, replay, concurrency, rollover | done (rollover in unit tests only) |
| 6. Dashboard, Telegram, wallet approval page, then P1 | approval page and Telegram notifier built and tested on sandbox (Telegram against a mock Bot API); dashboard and P1 not started |

## P0 checklist (AGENTS.md section 4)

| # | Item | State |
|---|---|---|
| 1 | single owner + agent + one NEP-141 token | local tested (sandbox) |
| 2 | policy with auto, daily and per-tx limits, allowlists, pause | local tested |
| 3 | agent requests via API/MCP; contract rejects unsafe requests | MCP server: local tested (sandbox, over stdio; Claude Code connects); **API not built** |
| 4 | auto payment executes with on-chain receipt | local tested (sandbox) |
| 5 | larger payment awaits approval; Telegram notice | local tested: the notifier alerts on sandbox, then follows up when paid; **real Telegram delivery untested** (mock Bot API; api.telegram.org unreachable here) |
| 6 | owner wallet approves the exact request; executes once | local tested in a real browser (sandbox, dev signer); wallet connector loads on a testnet build; **signing with a real wallet on testnet not yet done** |
| 7 | dashboard | open-request list only |
| 8 | Security Lab, at least 6 negative tests | 15 of 18 cases covered at contract level (see THREAT_MODEL.md); no UI |
| 9 | public app, README, video, submission | not started |

## Tests (last run 2026-10-24)

| Command | Result |
|---|---|
| `scripts/test-contracts.sh` | vault unit 51 passed; mock-ft unit 1 passed; sandbox 10 passed |
| `cargo clippy --workspace --all-targets -- -D warnings` (in `contracts/`) | clean |
| `cargo fmt --all --check` | clean |
| `pnpm lint && pnpm typecheck && pnpm test && pnpm build` | clean; shared 19 passed, web 14 passed, mcp 24 passed, notifier 27 passed |
| `pnpm notifier:sandbox` (built notifier, local sandbox, mock Bot API) | 4 passed: links only the private chat with the terminal's code (group, wrong code and forged button ignored); alert with exact terms and the approval page as the only link; follow-up after the owner approves and pays; after a restart no repeats, and a new request is alerted with the link in its note defanged |
| `pnpm mcp:sandbox` (built MCP server over stdio, local sandbox) | 11 passed: two tools only; auto payment settles; larger request waits, then is paid after the owner approves; hard cap blocked; T18 prompt-injected request to an unlisted account blocked; duplicate id not paid twice; bad input sends nothing; startup refused with a full-access key, a key for another contract, or a missing key |
| `pnpm e2e` (Chromium, local sandbox; the agent signs with its function-call key) | 7 passed: approve and pay, reject, altered recipient flagged, forged hash refused by the vault, non-owner blocked, foreign-vault link refused, open-request list |

Manual check on a testnet build: the near-connect wallet selector opens with no page errors and lists Meteor, Intear, Ledger, Nightly, Ethereum wallets and NEAR CLI (2026-10-24).

GitHub Actions `ci` run 1 (commit `8b91f83`) passed both jobs. The contracts job ran all 8 sandbox tests on the hosted runner without the rlimit shim.

Measured: an auto payment (request + ft_transfer + callback) burnt about 7 Tgas in sandbox.

Testnet deploy rehearsal (2026-10-24): `scripts/rehearse-deploy-sandbox.sh` ran `scripts/deploy-testnet.sh` unchanged with near-cli-rs 0.30.1 against a fresh sandbox node (protocol version 86). All six checks passed: vault owner and network set, the 3 TUSD request SETTLED, the 25 TUSD request AWAITING_APPROVAL, payee balance 3 TUSD, vault balance 997 TUSD. Commands come from the NEAR docs (`near/docs` @ `04d956c`, see INTEGRATIONS.md). Not covered: the faucet, the testnet network itself, and wallet signing.

Telegram notifier (2026-10-24): `apps/notifier` alerts the owner when a payment waits and follows up when it settles (DECISIONS ADR-020). It is tested against a mock Bot API, because Telegram is unreachable from here. The sandbox test caught a real bug: the first version assumed `list_requests` is oldest first (it is newest first) and missed requests that came after its first pass.

Rename (2026-10-24): the project is now Spact (DECISIONS ADR-019), including the hash domain and event standard. After the rename all suites passed again: contracts (51 unit, 1 mock-ft, 10 sandbox), TypeScript (shared 19, web 14, mcp 24), `pnpm e2e` 7, `pnpm mcp:sandbox` 11, and the deploy rehearsal's 10 checks.

MCP server (2026-10-24): `apps/mcp` gives the agent `request_payment` and `get_payment_status` over stdio, signed with its function-call key (DECISIONS ADR-018). With an isolated config, `claude mcp add` plus `claude mcp list` (Claude Code 2.1.310) showed the sandbox server as `Connected`. Codex was not available here to try.

Agent key (2026-10-24): the agent now signs with a function-call key that reaches only the vault's `request_direct_payment` and `execute_request` (DECISIONS ADR-017). Sandbox tests `t19_*` and `t20_*` show that it works for requests and execution, and that the protocol rejects everything else: other contracts, other vault methods, deposits, NEAR transfers, adding keys, deleting the account, and use after the allowance runs out. The rehearsal now runs the deploy script's own key step and passes ten checks: the key's receiver, methods and allowance, a refused NEAR transfer, and the six earlier ones. Two agent requests used 0.00092 NEAR of the 0.25 NEAR allowance.

## Unresolved risks

- Eligibility of code written before 2026-11-01 (DECISIONS ADR-000).
- The vault account's full-access key can redeploy the code (THREAT_MODEL).
- On testnet the agent account's full-access key stays with the operator (ADR-017); the mainnet choice is open.
- No reconciliation path for a stuck TRANSFER_PENDING; no storage pruning.
- Testnet/mainnet protocol support for the rustc 1.97 wasm output is unverified.
- The approval page has not signed with a real wallet yet; no CSP / frame-ancestors headers.

## Next smallest task

On a machine that can reach testnet: follow README "Deploy to testnet". Record the contract ids, code hash and the settled `demo-auto-1` transaction here, then approve `demo-approve-1` from the approval page with the owner's testnet wallet.
Check that `view_access_key_list` for `agent.<name>.testnet` shows the function-call key, and keep the printed operator key file away from the agent runtime.

Then add the MCP server to Claude Code with the testnet values (apps/mcp/README.md), ask it to pay `api.<name>.testnet`, and record the transaction here. With a bot from @BotFather, run the notifier (apps/notifier/README.md) and check that the alert arrives on the phone.
