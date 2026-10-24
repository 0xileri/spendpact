# Spact MCP server

A local stdio [MCP](https://modelcontextprotocol.io) server that lets an AI agent (Claude Code, Codex, any MCP host) ask a Spact vault to pay someone. The vault's on-chain policy decides what happens. The agent's key is a NEAR function-call key that can call only the vault's `request_direct_payment` and `execute_request`.

## Tools

Exactly two. There is no tool to change the policy, approve a payment, export a key or call another contract.

| Tool | Input | Result |
|---|---|---|
| `request_payment` | `token`, `amount_units` (string, smallest unit), `recipient`, `reason`, `request_id` | `policy_decision` (`AUTO_APPROVED`, `OWNER_APPROVAL_REQUIRED`, `BLOCKED`), `onchain_status`, `reason_code`, `explanation`, `tx_hash`, and `review_url` (the owner's approval page) when the owner must decide |
| `get_payment_status` | `request_id` | `source_status` (a vault status or `NOT_FOUND`), `reason_code`, amount, token, recipient, expiry by chain time |

Results come back once the transaction and the token transfer are in final blocks, so `SETTLED` is never optimistic. Retrying with the same `request_id` is safe: the vault answers `DUPLICATE_REQUEST` and never pays an id twice. The agent's `reason` text is passed to the vault, which shows it to the owner. It is never echoed back in tool results.

## Safety checks

The server refuses to start, and checks again before each `request_payment`, unless all of these hold:

- the key file is readable only by you (`chmod 600`) and its public key matches its private key
- the key is a **function-call** key on `SPACT_AGENT_ID`, for `SPACT_VAULT_ID`, limited to `request_direct_payment` and/or `execute_request`. A full-access key is always refused.
- the vault's stored network equals `SPACT_NETWORK`, and the agent is one of its agents
- mainnet only with `ENABLE_MAINNET_TRANSFERS=true`

The vault enforces the policy either way. These checks keep a misconfigured host from running with more authority than it needs.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `SPACT_NETWORK` | yes | `sandbox`, `testnet` or `mainnet` |
| `SPACT_RPC_URL` | yes | NEAR JSON-RPC endpoint (https outside sandbox) |
| `SPACT_VAULT_ID` | yes | the vault account |
| `SPACT_AGENT_ID` | yes | the agent account that owns the key |
| `SPACT_AGENT_KEY_FILE` | yes | near-cli key file of the agent's function-call key (`scripts/deploy-testnet.sh` writes one) |
| `SPACT_APPROVAL_URL` | no | base URL of the approval page, for `review_url` |
| `SPACT_EXPLORER_TX_URL` | no | explorer template with `{hash}`; defaults to nearblocks on testnet and mainnet |
| `ENABLE_MAINNET_TRANSFERS` | mainnet | must be `true` to run against mainnet |

Logs go to stderr as one JSON line per tool call (request id, status, reason code, transaction hash). Keys are never logged.

## Use it

Build it first: `pnpm install --frozen-lockfile && pnpm build`.

**Local sandbox:** `scripts/dev-sandbox.sh` starts a chain, writes the agent's key file and prints both commands below with the right values.

**Testnet**, after `scripts/deploy-testnet.sh <name>.testnet <owner>.testnet`:

```bash
# Claude Code
claude mcp add spact \
  -e SPACT_NETWORK=testnet \
  -e SPACT_RPC_URL=https://test.rpc.fastnear.com \
  -e SPACT_VAULT_ID=vault.<name>.testnet \
  -e SPACT_AGENT_ID=agent.<name>.testnet \
  -e SPACT_AGENT_KEY_FILE=$HOME/.near-credentials/spact/agent.<name>.testnet.json \
  -- node "$PWD/apps/mcp/dist/index.js"

# Codex
codex mcp add spact \
  --env SPACT_NETWORK=testnet \
  --env SPACT_RPC_URL=https://test.rpc.fastnear.com \
  --env SPACT_VAULT_ID=vault.<name>.testnet \
  --env SPACT_AGENT_ID=agent.<name>.testnet \
  --env SPACT_AGENT_KEY_FILE=$HOME/.near-credentials/spact/agent.<name>.testnet.json \
  -- node "$PWD/apps/mcp/dist/index.js"
```

Run these from the repo root. Point `SPACT_AGENT_KEY_FILE` at the restricted key the deploy script printed, never at the agent's full-access key in `~/.near-credentials/testnet/` (the server would refuse it anyway). `claude mcp list` should show `spact ... Connected`. The testnet commands have not been run yet; the sandbox ones have (docs/STATUS.md).

## Tests

```bash
pnpm --filter @spact/mcp test   # tools over an in-memory MCP connection, with a fake chain
pnpm mcp:sandbox                    # the built server over stdio against a local sandbox chain
```

The sandbox suite pays a small request, leaves a larger one for the owner and then sees it paid after approval. It also checks that these are blocked or refused: a request over the hard cap, a prompt-injected request to an unlisted account (T18), a repeated request id, malformed input, and startup with a full-access key, a key for another contract, or a key the account does not have. Each case is checked against chain state.
