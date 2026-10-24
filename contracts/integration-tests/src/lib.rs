//! Shared NEAR sandbox setup for the integration tests and the local demo (`demo-sandbox`).
//!
//! Deploys the mock token and the vault from `target/wasm32-unknown-unknown/release`, so run
//! `scripts/build-contracts.sh` first.

use near_workspaces::network::Sandbox;
use near_workspaces::operations::Function;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};

pub const UNIT: u128 = 1_000_000; // 6-decimal test token
pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
pub const AGENT_GAS: Gas = Gas::from_tgas(100);
/// The only vault methods the agent's restricted key may call.
pub const AGENT_METHODS: [&str; 2] = ["request_direct_payment", "execute_request"];

pub fn wasm(name: &str) -> Vec<u8> {
    let path = format!("{}/../target/wasm32-unknown-unknown/release/{name}.wasm", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap_or_else(|_| panic!("{path} missing: run scripts/build-contracts.sh first"))
}

pub struct Deployment {
    pub worker: Worker<Sandbox>,
    pub owner: Account,
    pub agent: Account,
    pub mallory: Account,
    pub api: Account,
    /// Allowlisted recipient that never registered storage with the token, so transfers fail.
    pub unregistered: Account,
    pub token: Contract,
    pub vault: Contract,
}

pub fn policy(recipients: &[&AccountId], token: &AccountId) -> Value {
    json!({
        "tokens": [{
            "token": token,
            "auto_limit": (10 * UNIT).to_string(),
            "hard_tx_limit": (30 * UNIT).to_string(),
            "daily_limit": (50 * UNIT).to_string(),
        }],
        "recipients": recipients,
        "max_open_approvals": 5,
        "max_requests_per_day": 50,
        "approval_ttl_sec": 3600,
    })
}

/// Creates `name.<root>` with its own random key. Without `.keys(...)`, near-workspaces gives every
/// subaccount the same deterministic key, which would let any one of them sign as the others.
pub async fn account(root: &Account, name: &str) -> anyhow::Result<Account> {
    Ok(root
        .create_subaccount(name)
        .keys(SecretKey::from_random(KeyType::ED25519))
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?)
}

pub async fn setup() -> anyhow::Result<Deployment> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let owner = account(&root, "owner").await?;
    let agent = account(&root, "agent").await?;
    let mallory = account(&root, "mallory").await?;
    let api = account(&root, "api").await?;
    let unregistered = account(&root, "unregistered").await?;

    let token = account(&root, "token").await?.deploy(&wasm("mock_ft")).await?.into_result()?;
    token
        .call("new")
        .args_json(json!({
            "owner_id": owner.id(),
            "total_supply": (1_000_000 * UNIT).to_string(),
            "symbol": "TUSD",
            "decimals": 6,
        }))
        .transact()
        .await?
        .into_result()?;

    // Deploy and initialize in one transaction signed by the vault account itself.
    let vault_account = account(&root, "vault").await?;
    vault_account
        .batch(vault_account.id())
        .deploy(&wasm("spact_vault"))
        .call(Function::new("new").args_json(json!({
            "owner": owner.id(),
            "agents": [agent.id()],
            "network": "sandbox",
            "policy": policy(&[api.id(), unregistered.id()], token.id()),
        })))
        .transact()
        .await?
        .into_result()?;
    let vault =
        Contract::from_secret_key(vault_account.id().clone(), vault_account.secret_key().clone(), &worker);

    for id in [vault.id(), api.id()] {
        owner
            .call(token.id(), "storage_deposit")
            .args_json(json!({ "account_id": id }))
            .deposit(NearToken::from_millinear(10))
            .transact()
            .await?
            .into_result()?;
    }
    owner
        .call(token.id(), "ft_transfer")
        .args_json(json!({ "receiver_id": vault.id(), "amount": (1_000 * UNIT).to_string() }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?
        .into_result()?;

    Ok(Deployment { worker, owner, agent, mallory, api, unregistered, token, vault })
}

impl Deployment {
    pub async fn balance(&self, id: &AccountId) -> anyhow::Result<u128> {
        let v: String =
            self.token.view("ft_balance_of").args_json(json!({ "account_id": id })).await?.json()?;
        Ok(v.parse()?)
    }

    pub async fn request(
        &self,
        id: &str,
        amount: u128,
        recipient: &AccountId,
    ) -> anyhow::Result<ExecutionFinalResult> {
        self.request_with_reason(id, amount, recipient, "sandbox test").await
    }

    pub async fn request_with_reason(
        &self,
        id: &str,
        amount: u128,
        recipient: &AccountId,
        reason: &str,
    ) -> anyhow::Result<ExecutionFinalResult> {
        self.request_signed(&self.agent, id, amount, recipient, reason).await
    }

    /// `request_direct_payment` signed by `signer`, e.g. the agent's restricted key.
    pub async fn request_signed(
        &self,
        signer: &Account,
        id: &str,
        amount: u128,
        recipient: &AccountId,
        reason: &str,
    ) -> anyhow::Result<ExecutionFinalResult> {
        Ok(signer
            .call(self.vault.id(), "request_direct_payment")
            .args_json(json!({
                "request_id": id,
                "token": self.token.id(),
                "amount": amount.to_string(),
                "recipient": recipient,
                "reason": reason,
            }))
            .gas(AGENT_GAS)
            .transact()
            .await?)
    }

    /// Gives the agent a function-call key that can only call [`AGENT_METHODS`] on the vault and
    /// spend at most `allowance` on gas, and deletes the agent's full-access key in the same
    /// transaction. Returns the agent signing with the new key; `self.agent` no longer works after
    /// this. On a real network keep the full-access key offline instead: once a function-call
    /// key's allowance runs out, only a full-access key can add a new one.
    pub async fn restrict_agent_key(&self, allowance: NearToken) -> anyhow::Result<Account> {
        let key = SecretKey::from_random(KeyType::ED25519);
        self.agent
            .batch(self.agent.id())
            .add_key(
                key.public_key(),
                AccessKey::function_call_access(self.vault.id(), &AGENT_METHODS, Some(allowance)),
            )
            .delete_key(self.agent.secret_key().public_key())
            .transact()
            .await?
            .into_result()?;
        Ok(Account::from_secret_key(self.agent.id().clone(), key, &self.worker))
    }

    pub async fn get_request(&self, id: &str) -> anyhow::Result<Value> {
        Ok(self.vault.view("get_request").args_json(json!({ "request_id": id })).await?.json()?)
    }

    pub async fn budget(&self) -> anyhow::Result<(u128, u128)> {
        let b: Value =
            self.vault.view("get_budget").args_json(json!({ "token": self.token.id() })).await?.json()?;
        Ok((b["executed"].as_str().unwrap().parse()?, b["pending"].as_str().unwrap().parse()?))
    }

    pub async fn config(&self) -> anyhow::Result<Value> {
        Ok(self.vault.view("get_config").await?.json()?)
    }
}
