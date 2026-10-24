#!/usr/bin/env bash
# Builds the contract wasm files that the sandbox tests deploy.
#
# Uses cargo-near's default rustflags (`-C link-arg=-s --cfg near`) without needing cargo-near
# installed. near-sdk >= 5.27 requires `--cfg near` to select on-chain host functions.
# wasm-opt is not run; see docs/DECISIONS.md (ADR-003).
set -euo pipefail
cd "$(dirname "$0")/../contracts"
cargo build --target wasm32-unknown-unknown --release -p spact-vault -p mock-ft \
  --config "build.rustflags=['-C','link-arg=-s','--cfg','near']"
sha256sum target/wasm32-unknown-unknown/release/spact_vault.wasm \
  target/wasm32-unknown-unknown/release/mock_ft.wasm
