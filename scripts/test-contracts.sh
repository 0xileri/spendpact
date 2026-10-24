#!/usr/bin/env bash
# Builds the contracts, runs unit tests, then runs the NEAR sandbox tests.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/scripts/build-contracts.sh"
cd "$ROOT/contracts"
cargo test -p spact-vault -p mock-ft

# shellcheck source=sandbox-env.sh
source "$ROOT/scripts/sandbox-env.sh"
env ${SANDBOX_LD_PRELOAD:+LD_PRELOAD="$SANDBOX_LD_PRELOAD"} cargo test -p integration-tests -- --test-threads=2
