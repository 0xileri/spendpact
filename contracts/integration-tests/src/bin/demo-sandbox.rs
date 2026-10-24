//! Starts a local NEAR sandbox with a funded Spact vault, then waits until interrupted.
//!
//! Usage: `demo-sandbox <fixture.json>`
//!
//! Writes the RPC address, contract ids and the sandbox owner and agent keys to the fixture file
//! (mode 0600) for the local dev signer and the browser tests. These keys exist only on this
//! throwaway local chain.

use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;

use anyhow::Context;
use integration_tests::{setup, AGENT_METHODS, UNIT};
use near_workspaces::types::NearToken;
use serde_json::json;
use tokio::signal::unix::{signal, SignalKind};

const DEMO_REQUEST: &str = "demo-approve-1";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let path = std::env::args().nth(1).context("usage: demo-sandbox <fixture.json>")?;

    let env = setup().await?;
    // The agent keeps only a function-call key for two vault methods (see AGENTS.md I1).
    let agent = env.restrict_agent_key(NearToken::from_near(1)).await?;
    // One payment the policy settled on its own, and one waiting for the owner.
    env.request_signed(&agent, "demo-auto-1", 3 * UNIT, env.api.id(), "Weather API: 1,000 calls")
        .await?
        .into_result()?;
    env.request_signed(&agent, DEMO_REQUEST, 25 * UNIT, env.api.id(), "Weather API: monthly plan upgrade")
        .await?
        .into_result()?;

    let fixture = json!({
        "warning": "sandbox-only keys for a throwaway local chain; never reuse",
        "network": "sandbox",
        "rpc_url": env.worker.rpc_addr(),
        "vault_id": env.vault.id(),
        "token_id": env.token.id(),
        "owner_id": env.owner.id(),
        "owner_secret_key": env.owner.secret_key().to_string(),
        "agent_id": agent.id(),
        "agent_secret_key": agent.secret_key().to_string(),
        "agent_key": format!("function-call key: {} on {}, 1 NEAR gas allowance", AGENT_METHODS.join(", "), env.vault.id()),
        "api_id": env.api.id(),
        "mallory_id": env.mallory.id(),
        "demo_request_id": DEMO_REQUEST,
    });
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&path)
        .with_context(|| format!("cannot write {path}"))?;
    file.write_all(serde_json::to_string_pretty(&fixture)?.as_bytes())?;
    drop(file);

    eprintln!("sandbox RPC {} | vault {} | fixture {path}", env.worker.rpc_addr(), env.vault.id());
    println!("READY");

    // Keep the worker (and the sandbox node it owns) alive until SIGINT or SIGTERM.
    let mut term = signal(SignalKind::terminate())?;
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
    eprintln!("stopping sandbox");
    Ok(())
}
