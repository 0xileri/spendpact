//! Canonical request digest that the owner approves.
//!
//! The encoding is borsh-compatible and versioned by the domain string:
//!
//! | field            | type   |
//! |------------------|--------|
//! | domain           | string (`"spact.request.v1"`) |
//! | network          | string |
//! | vault_id         | string |
//! | request_id       | string |
//! | agent_id         | string |
//! | route            | u8     |
//! | token            | string |
//! | amount           | u128   |
//! | recipient        | string |
//! | reason           | string |
//! | expires_at_ns    | u64    |
//! | policy_version   | u64    |
//!
//! `string` is a little-endian u32 byte length followed by UTF-8 bytes; integers are
//! little-endian. `request_hash = lowercase_hex(sha256(encoding))`.
//!
//! Binding the vault id and network makes a hash from one vault or network useless on another.
//! Binding the policy version makes approvals stale after any policy change.

use near_sdk::env;

use crate::types::PaymentRequest;

pub const DIGEST_DOMAIN: &str = "spact.request.v1";

pub fn encode_request(network: &str, vault_id: &str, req: &PaymentRequest) -> Vec<u8> {
    let mut out = Vec::with_capacity(256);
    put_str(&mut out, DIGEST_DOMAIN);
    put_str(&mut out, network);
    put_str(&mut out, vault_id);
    put_str(&mut out, &req.request_id);
    put_str(&mut out, req.agent_id.as_str());
    out.push(req.route.tag());
    put_str(&mut out, req.token.as_str());
    out.extend_from_slice(&req.amount.0.to_le_bytes());
    put_str(&mut out, req.recipient.as_str());
    put_str(&mut out, &req.reason);
    out.extend_from_slice(&req.expires_at_ns.0.to_le_bytes());
    out.extend_from_slice(&req.policy_version.to_le_bytes());
    out
}

pub fn request_hash(network: &str, vault_id: &str, req: &PaymentRequest) -> String {
    to_hex(&env::sha256(encode_request(network, vault_id, req)))
}

fn put_str(out: &mut Vec<u8>, s: &str) {
    // Inputs are bounded far below u32::MAX by validation, so the cast cannot truncate.
    out.extend_from_slice(&(s.len() as u32).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}
