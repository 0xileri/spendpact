//! NEAR sandbox tests: a real local node, the real vault wasm and a real NEP-141 token.
//!
//! Run `scripts/build-contracts.sh` first, then `cargo test -p integration-tests`.
//! Test IDs (S1, T03, ...) refer to AGENTS.md sections 10 and 13.

use integration_tests::{account, policy, setup, wasm, AGENT_GAS, AGENT_METHODS, ONE_YOCTO, UNIT};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, AccessKeyPermission, KeyType, NearToken, SecretKey};
use near_workspaces::Account;
use serde_json::{json, Value};

/// A call that must fail with `code` in its panic message.
fn assert_fails_with(result: ExecutionFinalResult, code: &str) {
    match result.into_result() {
        Ok(ok) => panic!("expected failure {code}, got success: {:?}", ok.raw_bytes()),
        Err(err) => {
            let msg = format!("{err:?}");
            assert!(msg.contains(code), "expected {code} in failure, got: {msg}");
        }
    }
}

// ------------------------------------------------------------------ S1

#[tokio::test]
async fn s1_auto_payment_moves_real_tokens() -> anyhow::Result<()> {
    let env = setup().await?;
    let before = env.balance(env.vault.id()).await?;

    let result = env.request("s1", 3 * UNIT, env.api.id()).await?;
    println!("S1 gas burnt: {} Tgas", result.total_gas_burnt.as_tgas());
    let outcome: Value = result.json()?;
    assert_eq!(outcome["status"], "SETTLED");
    assert_eq!(outcome["reason_code"], "SETTLED");

    assert_eq!(env.balance(env.api.id()).await?, 3 * UNIT);
    assert_eq!(env.balance(env.vault.id()).await?, before - 3 * UNIT);
    assert_eq!(env.budget().await?, (3 * UNIT, 0));
    assert_eq!(env.get_request("s1").await?["status"], "SETTLED");
    Ok(())
}

// ------------------------------------------------------------------ S2, T03

#[tokio::test]
async fn s2_approval_needs_the_owner_wallet_and_executes_once() -> anyhow::Result<()> {
    let env = setup().await?;
    let outcome: Value = env.request("s2", 25 * UNIT, env.api.id()).await?.json()?;
    assert_eq!(outcome["status"], "AWAITING_APPROVAL");
    let hash = outcome["request_hash"].as_str().unwrap().to_string();
    assert_eq!(env.balance(env.api.id()).await?, 0, "nothing moves before approval");

    // The agent cannot approve its own request.
    let r = env
        .agent
        .call(env.vault.id(), "approve_request")
        .args_json(json!({ "request_id": "s2", "request_hash": hash }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?;
    assert_fails_with(r, "NOT_OWNER");

    // A function-call key on the owner account (what a dApp or backend could hold) cannot
    // approve either: approvals need 1 yocto and function-call keys cannot attach deposits.
    let fc_key = SecretKey::from_random(KeyType::ED25519);
    env.owner
        .batch(env.owner.id())
        .add_key(fc_key.public_key(), AccessKey::function_call_access(env.vault.id(), &[], None))
        .transact()
        .await?
        .into_result()?;
    let owner_fc = Account::from_secret_key(env.owner.id().clone(), fc_key, &env.worker);
    let attempt = owner_fc
        .call(env.vault.id(), "approve_request")
        .args_json(json!({ "request_id": "s2", "request_hash": hash }))
        .deposit(ONE_YOCTO)
        .transact()
        .await;
    // The protocol rejects the transaction before it reaches the vault.
    let err = attempt.expect_err("function-call key must not be able to attach the approval deposit");
    assert!(format!("{err:?}").contains("DepositWithFunctionCall"), "unexpected rejection: {err:?}");
    assert_eq!(env.get_request("s2").await?["status"], "AWAITING_APPROVAL");

    // A wrong hash fails.
    let r = env
        .owner
        .call(env.vault.id(), "approve_request")
        .args_json(json!({ "request_id": "s2", "request_hash": "00".repeat(32) }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?;
    assert_fails_with(r, "HASH_MISMATCH");

    // The owner's full-access key approves the exact hash.
    let approved: Value = env
        .owner
        .call(env.vault.id(), "approve_request")
        .args_json(json!({ "request_id": "s2", "request_hash": hash }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?
        .json()?;
    assert_eq!(approved["status"], "APPROVED");

    let executed: Value = env
        .agent
        .call(env.vault.id(), "execute_request")
        .args_json(json!({ "request_id": "s2" }))
        .gas(AGENT_GAS)
        .transact()
        .await?
        .json()?;
    assert_eq!(executed["status"], "SETTLED");
    assert_eq!(env.balance(env.api.id()).await?, 25 * UNIT);

    // T03: a second execution fails and moves nothing.
    let again = env
        .agent
        .call(env.vault.id(), "execute_request")
        .args_json(json!({ "request_id": "s2" }))
        .gas(AGENT_GAS)
        .transact()
        .await?;
    assert_fails_with(again, "INVALID_STATE");
    assert_eq!(env.balance(env.api.id()).await?, 25 * UNIT);
    assert_eq!(env.budget().await?, (25 * UNIT, 0));
    Ok(())
}

// ------------------------------------------------------------------ T04

#[tokio::test]
async fn t04_parallel_split_payments_respect_daily_budget() -> anyhow::Result<()> {
    let env = setup().await?;
    // Six 10-unit requests in flight at once against a 50-unit UTC-day budget.
    let mut pending = Vec::new();
    for i in 0..6 {
        let tx = env
            .agent
            .call(env.vault.id(), "request_direct_payment")
            .args_json(json!({
                "request_id": format!("split-{i}"),
                "token": env.token.id(),
                "amount": (10 * UNIT).to_string(),
                "recipient": env.api.id(),
                "reason": "split attempt",
            }))
            .gas(AGENT_GAS)
            .transact_async()
            .await?;
        pending.push(tx);
    }
    let mut settled = 0;
    let mut blocked = 0;
    for tx in pending {
        let outcome: Value = tx.await?.json()?;
        match outcome["status"].as_str().unwrap() {
            "SETTLED" => settled += 1,
            "BLOCKED" => {
                assert_eq!(outcome["reason_code"], "DAILY_BUDGET_EXCEEDED");
                blocked += 1;
            }
            other => panic!("unexpected status {other}"),
        }
    }
    assert_eq!((settled, blocked), (5, 1));
    assert_eq!(env.balance(env.api.id()).await?, 50 * UNIT);
    assert_eq!(env.budget().await?, (50 * UNIT, 0));
    Ok(())
}

// ------------------------------------------------------------------ T08

#[tokio::test]
async fn t08_failed_transfer_releases_reservation_and_keeps_funds() -> anyhow::Result<()> {
    let env = setup().await?;
    let before = env.balance(env.vault.id()).await?;
    let result = env.request("t08", 3 * UNIT, env.unregistered.id()).await?;
    assert!(!result.receipt_failures().is_empty(), "the token transfer itself should fail");
    let outcome: Value = result.json()?;
    assert_eq!(outcome["status"], "TRANSFER_FAILED");
    assert_eq!(outcome["reason_code"], "SOURCE_TRANSFER_FAILED");
    assert_eq!(env.balance(env.vault.id()).await?, before);
    assert_eq!(env.budget().await?, (0, 0), "reservation released, nothing counted as spent");
    Ok(())
}

// ------------------------------------------------------------------ T16

#[tokio::test]
async fn t16_callback_cannot_be_called_from_outside() -> anyhow::Result<()> {
    let env = setup().await?;
    env.request("t16", 3 * UNIT, env.unregistered.id()).await?.into_result()?;
    assert_eq!(env.get_request("t16").await?["status"], "TRANSFER_FAILED");

    for caller in [&env.mallory, &env.agent, &env.owner] {
        let r = caller
            .call(env.vault.id(), "on_transfer_result")
            .args_json(json!({ "request_id": "t16" }))
            .gas(AGENT_GAS)
            .transact()
            .await?;
        assert_fails_with(r, "is private");
    }
    assert_eq!(env.get_request("t16").await?["status"], "TRANSFER_FAILED");
    assert_eq!(env.budget().await?, (0, 0));
    Ok(())
}

// ------------------------------------------------------------------ T05, T18

/// Everything a prompt-injected agent could try with its own key. None of it moves funds.
#[tokio::test]
async fn t18_agent_cannot_move_funds_outside_policy() -> anyhow::Result<()> {
    let env = setup().await?;
    let vault_before = env.balance(env.vault.id()).await?;
    let attacker = env.mallory.id();

    let tries: Vec<(&str, Value, NearToken, &str)> = vec![
        (
            "owner_withdraw",
            json!({ "token": env.token.id(), "amount": (100 * UNIT).to_string(), "receiver_id": attacker }),
            ONE_YOCTO,
            "NOT_OWNER",
        ),
        ("set_policy", json!({ "policy": policy(&[attacker], env.token.id()) }), ONE_YOCTO, "NOT_OWNER"),
        ("add_agent", json!({ "agent_id": attacker }), ONE_YOCTO, "NOT_OWNER"),
        ("set_paused", json!({ "paused": false }), ONE_YOCTO, "NOT_OWNER"),
    ];
    for (method, args, deposit, code) in tries {
        let r = env
            .agent
            .call(env.vault.id(), method)
            .args_json(args)
            .deposit(deposit)
            .gas(AGENT_GAS)
            .transact()
            .await?;
        assert_fails_with(r, code);
    }

    let blocked: Value = env.request("to-attacker", 3 * UNIT, attacker).await?.json()?;
    assert_eq!(blocked["reason_code"], "RECIPIENT_NOT_ALLOWED");
    let blocked: Value = env.request("too-big", 31 * UNIT, env.api.id()).await?.json()?;
    assert_eq!(blocked["reason_code"], "HARD_CAP_EXCEEDED");

    assert_eq!(env.balance(env.vault.id()).await?, vault_before);
    assert_eq!(env.balance(attacker).await?, 0);
    assert_eq!(env.config().await?["policy_version"], 1);
    Ok(())
}

// ------------------------------------------------------------------ init front-running

#[tokio::test]
async fn deployed_vault_cannot_be_initialized_by_someone_else() -> anyhow::Result<()> {
    let env = setup().await?;
    let root = env.worker.root_account()?;
    let fresh = account(&root, "fresh-vault").await?;
    fresh.deploy(&wasm("spact_vault")).await?.into_result()?;
    let r = env
        .mallory
        .call(fresh.id(), "new")
        .args_json(json!({
            "owner": env.mallory.id(),
            "agents": [env.agent.id()],
            "network": "sandbox",
            "policy": policy(&[env.mallory.id()], env.token.id()),
        }))
        .transact()
        .await?;
    assert_fails_with(r, "INIT_NOT_SELF");
    Ok(())
}

// ------------------------------------------------------------------ pause and recovery

#[tokio::test]
async fn pause_blocks_payments_and_owner_can_recover_funds() -> anyhow::Result<()> {
    let env = setup().await?;
    env.owner
        .call(env.vault.id(), "set_paused")
        .args_json(json!({ "paused": true }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?
        .into_result()?;
    let blocked: Value = env.request("paused", UNIT, env.api.id()).await?.json()?;
    assert_eq!(blocked["reason_code"], "VAULT_PAUSED");

    let vault_before = env.balance(env.vault.id()).await?;
    let owner_before = env.balance(env.owner.id()).await?;
    env.owner
        .call(env.vault.id(), "owner_withdraw")
        .args_json(json!({ "token": env.token.id(), "amount": (100 * UNIT).to_string(), "receiver_id": env.owner.id() }))
        .deposit(ONE_YOCTO)
        .gas(AGENT_GAS)
        .transact()
        .await?
        .into_result()?;
    assert_eq!(env.balance(env.vault.id()).await?, vault_before - 100 * UNIT);
    assert_eq!(env.balance(env.owner.id()).await?, owner_before + 100 * UNIT);
    Ok(())
}

// ------------------------------------------------------------------ T19, T20 restricted agent key

/// A transaction the protocol must refuse before any contract code runs.
fn assert_rejected<T: std::fmt::Debug, E: std::fmt::Debug>(result: Result<T, E>, kind: &str) {
    match result {
        Ok(ok) => panic!("expected the protocol to reject it with {kind}, got {ok:?}"),
        Err(err) => {
            let msg = format!("{err:?}");
            assert!(msg.contains(kind), "expected {kind}, got: {msg}");
        }
    }
}

/// The agent holds only a function-call key for two vault methods. That is all it needs, and the
/// protocol refuses everything else the key might try, even with no contract checks at all.
#[tokio::test]
async fn t19_restricted_agent_key_can_only_request_and_execute() -> anyhow::Result<()> {
    let env = setup().await?;
    let agent = env.restrict_agent_key(NearToken::from_near(1)).await?;

    let keys = agent.view_access_keys().await?;
    assert_eq!(keys.len(), 1, "the full-access key is gone");
    match &keys[0].access_key.permission {
        AccessKeyPermission::FunctionCall(p) => {
            assert_eq!(p.receiver_id, env.vault.id().as_str());
            assert_eq!(p.method_names, AGENT_METHODS);
            assert_eq!(p.allowance, Some(NearToken::from_near(1)));
        }
        other => panic!("expected a function-call key, got {other:?}"),
    }

    // What the agent is for still works.
    let paid: Value =
        env.request_signed(&agent, "fc-auto", 3 * UNIT, env.api.id(), "restricted key").await?.json()?;
    assert_eq!(paid["status"], "SETTLED");
    let waiting: Value =
        env.request_signed(&agent, "fc-approve", 25 * UNIT, env.api.id(), "restricted key").await?.json()?;
    assert_eq!(waiting["status"], "AWAITING_APPROVAL");
    env.owner
        .call(env.vault.id(), "approve_request")
        .args_json(json!({ "request_id": "fc-approve", "request_hash": waiting["request_hash"] }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?
        .into_result()?;
    let executed: Value = agent
        .call(env.vault.id(), "execute_request")
        .args_json(json!({ "request_id": "fc-approve" }))
        .gas(AGENT_GAS)
        .transact()
        .await?
        .json()?;
    assert_eq!(executed["status"], "SETTLED");
    assert_eq!(env.balance(env.api.id()).await?, 28 * UNIT);

    // Everything else is refused by the protocol.
    let vault_tokens = env.balance(env.vault.id()).await?;
    let mallory_near = env.mallory.view_account().await?.balance;
    assert_rejected(
        agent
            .call(env.token.id(), "ft_balance_of")
            .args_json(json!({ "account_id": agent.id() }))
            .transact()
            .await,
        "ReceiverMismatch",
    );
    assert_rejected(
        agent
            .call(env.vault.id(), "expire_request")
            .args_json(json!({ "request_id": "fc-approve" }))
            .transact()
            .await,
        "MethodNameMismatch",
    );
    assert_rejected(
        agent
            .call(env.vault.id(), "set_paused")
            .args_json(json!({ "paused": true }))
            .deposit(ONE_YOCTO)
            .transact()
            .await,
        "DepositWithFunctionCall",
    );
    assert_rejected(
        agent.transfer_near(env.mallory.id(), NearToken::from_millinear(100)).await,
        "RequiresFullAccess",
    );
    let attacker_key = SecretKey::from_random(KeyType::ED25519);
    assert_rejected(
        agent.batch(agent.id()).add_key(attacker_key.public_key(), AccessKey::full_access()).transact().await,
        "RequiresFullAccess",
    );
    assert_rejected(
        agent.batch(agent.id()).delete_account(env.mallory.id()).transact().await,
        "RequiresFullAccess",
    );

    assert_eq!(env.balance(env.vault.id()).await?, vault_tokens);
    assert_eq!(env.mallory.view_account().await?.balance, mallory_near);
    assert_eq!(agent.view_access_keys().await?.len(), 1);
    Ok(())
}

/// The allowance caps what the key can spend on gas. It is not a payment limit: the vault's
/// budget is. A key whose allowance cannot cover one call's prepaid gas is refused outright.
#[tokio::test]
async fn t20_agent_key_allowance_caps_gas_spending() -> anyhow::Result<()> {
    let env = setup().await?;
    let agent = env.restrict_agent_key(NearToken::from_yoctonear(1)).await?;
    assert_rejected(
        env.request_signed(&agent, "no-gas", UNIT, env.api.id(), "too little allowance").await,
        "NotEnoughAllowance",
    );
    assert!(env.get_request("no-gas").await?.is_null(), "nothing reached the vault");
    assert_eq!(env.budget().await?, (0, 0));
    Ok(())
}
