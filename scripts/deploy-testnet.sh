#!/usr/bin/env bash
# Deploys Spact to NEAR testnet with near-cli-rs:
#   tusd.<parent>   test NEP-141 token (mock-ft, 6 decimals; no real value)
#   vault.<parent>  Spact vault, owned by <owner>, deployed and initialized in one transaction
#   agent.<parent>  the agent account. It gets a function-call key limited to request_direct_payment and
#                   execute_request on the vault, saved to its own file for the agent runtime. The account's
#                   full-access key stays in your keychain as the operator key; never give it to the agent.
#   api.<parent>    the demo payee
# then funds the vault and creates two demo requests: one paid automatically, one awaiting approval.
#
# Usage: scripts/deploy-testnet.sh <parent-account> <owner-account>
#   parent-account  funded account in your legacy keychain (~/.near-credentials), e.g. spact-demo.testnet
#                   create one: near account create-account sponsor-by-faucet-service <name>.testnet \
#                                 autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
#   owner-account   the wallet account that approves payments, e.g. alice.testnet (create it in a wallet)
#
# Run it once per deployer account: it stops if the subaccounts already exist.
#
# Commands follow docs.near.org (source: github.com/near/docs @ 04d956c, 2026-10-24), except the flags of
# `add-key grant-function-call-access`, which come from near-cli-rs 0.30.1 `--help` (the docs only show
# grant-full-access). They were rehearsed against a local sandbox, not testnet; see docs/STATUS.md.
#
# Environment overrides:
#   NETWORK_CONFIG  near-cli-rs connection name (default: testnet)
#   NETWORK_LABEL   network string stored in the vault and used in request hashes (default: testnet)
#   RPC_URL         RPC used for checks and printed for the web app (default: https://test.rpc.fastnear.com)
#   VAULT_NEAR / TOKEN_NEAR / AGENT_NEAR / API_NEAR  initial balances (defaults 3.5 / 2.5 / 0.5 / 0.1)
#   AGENT_ALLOWANCE  gas allowance of the agent's restricted key (default: 0.25 NEAR)
#   NEAR_CREDENTIALS_DIR / NEAR_NETWORK_NAME  where near-cli's legacy keychain lives
#                    (defaults: ~/.near-credentials and testnet)
#   AGENT_KEY_FILE   where to write the agent's restricted key (default: <credentials>/spact/<agent>.json)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PARENT="${1:?usage: deploy-testnet.sh <parent-account> <owner-account>}"
OWNER="${2:?usage: deploy-testnet.sh <parent-account> <owner-account>}"
NET="${NETWORK_CONFIG:-testnet}"
LABEL="${NETWORK_LABEL:-testnet}"
RPC_URL="${RPC_URL:-https://test.rpc.fastnear.com}"
VAULT="vault.$PARENT"
TOKEN="tusd.$PARENT"
AGENT="agent.$PARENT"
API="api.$PARENT"
UNIT=1000000 # 1 TUSD in base units (6 decimals)
AGENT_METHODS='request_direct_payment, execute_request'
KEYCHAIN="${NEAR_CREDENTIALS_DIR:-$HOME/.near-credentials}/${NEAR_NETWORK_NAME:-testnet}"
AGENT_KEY_FILE="${AGENT_KEY_FILE:-${NEAR_CREDENTIALS_DIR:-$HOME/.near-credentials}/spact/$AGENT.json}"

die() { echo "error: $*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*" >&2; }
command -v near >/dev/null || die "near-cli-rs not found (see https://docs.near.org/tools/cli#installation)"
[ "$OWNER" != "$VAULT" ] && [ "$OWNER" != "$AGENT" ] || die "owner must not be the vault or the agent"
[ "$OWNER" != "$PARENT" ] || echo "warning: owner is the deployer account; a separate wallet account is safer" >&2

rpc() { curl -sS --fail -X POST "$RPC_URL" -H 'content-type: application/json' -d "$1"; }

step "Checking the network"
# The vault is built with rustc 1.97, whose wasm needs protocol version >= 84 (nearcore 2.12).
pv="$(rpc '{"jsonrpc":"2.0","id":"x","method":"status","params":[]}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).result.protocol_version))')"
echo "protocol version $pv" >&2
[ "$pv" -ge 84 ] || die "protocol version $pv < 84: rebuild the contracts with rustc <= 1.86"

step "Building contracts"
"$ROOT/scripts/build-contracts.sh" >&2
WASM_DIR="$ROOT/contracts/target/wasm32-unknown-unknown/release"

step "Creating subaccounts of $PARENT"
for spec in "$TOKEN:${TOKEN_NEAR:-2.5}" "$VAULT:${VAULT_NEAR:-3.5}" "$AGENT:${AGENT_NEAR:-0.5}" "$API:${API_NEAR:-0.1}"; do
  id="${spec%%:*}"
  amount="${spec##*:}"
  near account create-account fund-myself "$id" "$amount NEAR" autogenerate-new-keypair save-to-legacy-keychain \
    sign-as "$PARENT" network-config "$NET" sign-with-legacy-keychain send
done

step "Deploying the test token to $TOKEN"
near contract deploy "$TOKEN" use-file "$WASM_DIR/mock_ft.wasm" with-init-call new \
  json-args "{\"owner_id\":\"$PARENT\",\"total_supply\":\"$((1000000 * UNIT))\",\"symbol\":\"TUSD\",\"decimals\":6}" \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config "$NET" sign-with-legacy-keychain send

step "Deploying and initializing the vault at $VAULT (one transaction, signed by the vault account)"
POLICY="{\"tokens\":[{\"token\":\"$TOKEN\",\"auto_limit\":\"$((10 * UNIT))\",\"hard_tx_limit\":\"$((30 * UNIT))\",\"daily_limit\":\"$((50 * UNIT))\"}],\"recipients\":[\"$API\"],\"max_open_approvals\":5,\"max_requests_per_day\":50,\"approval_ttl_sec\":86400}"
near contract deploy "$VAULT" use-file "$WASM_DIR/spact_vault.wasm" with-init-call new \
  json-args "{\"owner\":\"$OWNER\",\"agents\":[\"$AGENT\"],\"network\":\"$LABEL\",\"policy\":$POLICY}" \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config "$NET" sign-with-legacy-keychain send

step "Giving the agent a restricted key: only $AGENT_METHODS on $VAULT"
# The docs describe `near generate-keypair`, but near-cli-rs 0.30.1 (latest stable) does not have it. So
# add-key generates the key into the legacy keychain, and we pick out the one new file it writes there.
before="$(ls "$KEYCHAIN/$AGENT" 2>/dev/null | sort || true)"
near account add-key "$AGENT" grant-function-call-access --allowance "${AGENT_ALLOWANCE:-0.25 NEAR}" \
  --contract-account-id "$VAULT" --function-names "$AGENT_METHODS" \
  autogenerate-new-keypair save-to-legacy-keychain network-config "$NET" sign-with-legacy-keychain send
new_key="$(comm -13 <(echo "$before") <(ls "$KEYCHAIN/$AGENT" | sort))"
[ "$(printf '%s\n' "$new_key" | grep -c .)" = 1 ] || die "could not find the new key in $KEYCHAIN/$AGENT"
mkdir -p "$(dirname "$AGENT_KEY_FILE")"
install -m 600 "$KEYCHAIN/$AGENT/$new_key" "$AGENT_KEY_FILE"
echo "agent's restricted key: $AGENT_KEY_FILE" >&2

step "Registering token storage for the vault and the payee, then funding the vault with 1000 TUSD"
for id in "$VAULT" "$API"; do
  near contract call-function as-transaction "$TOKEN" storage_deposit json-args "{\"account_id\":\"$id\"}" \
    prepaid-gas '30.0 Tgas' attached-deposit '0.01 NEAR' sign-as "$PARENT" network-config "$NET" sign-with-legacy-keychain send
done
near contract call-function as-transaction "$TOKEN" ft_transfer \
  json-args "{\"receiver_id\":\"$VAULT\",\"amount\":\"$((1000 * UNIT))\"}" \
  prepaid-gas '30.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$PARENT" network-config "$NET" sign-with-legacy-keychain send

step "Agent requests, signed with its restricted key: 3 TUSD (paid automatically) and 25 TUSD (waits for $OWNER)"
request() {
  near contract call-function as-transaction "$VAULT" request_direct_payment \
    json-args "{\"request_id\":\"$1\",\"token\":\"$TOKEN\",\"amount\":\"$2\",\"recipient\":\"$API\",\"reason\":\"$3\"}" \
    prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' sign-as "$AGENT" network-config "$NET" \
    sign-with-access-key-file "$AGENT_KEY_FILE" send
}
request demo-auto-1 "$((3 * UNIT))" "Weather API: 1,000 calls"
request demo-approve-1 "$((25 * UNIT))" "Weather API: monthly plan upgrade"

step "Done"
code_hash="$(rpc "{\"jsonrpc\":\"2.0\",\"id\":\"x\",\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$VAULT\"}}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).result.code_hash))')"
cat <<EOF
vault      $VAULT (code hash $code_hash)
token      $TOKEN
agent      $AGENT
           restricted key ($AGENT_METHODS on $VAULT): $AGENT_KEY_FILE
           full-access operator key: $KEYCHAIN/$AGENT.json (keep it away from the agent)
payee      $API
owner      $OWNER

Put this in apps/web/.env.local, then run: pnpm --filter @spact/web dev
VITE_NEAR_NETWORK=$LABEL
VITE_NEAR_RPC_URL=$RPC_URL
VITE_VAULT_ID=$VAULT

Then open http://localhost:5173/?request=demo-approve-1 and approve with the $OWNER wallet.

Note: the full-access key for $VAULT is now in ~/.near-credentials. Whoever holds it can redeploy the
vault and bypass every rule (docs/THREAT_MODEL.md). Keep it offline.
EOF
