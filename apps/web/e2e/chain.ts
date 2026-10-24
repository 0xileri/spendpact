import { readFileSync } from "node:fs";

import { Account, JsonRpcProvider, teraToGas, type KeyPairString } from "near-api-js";

/** Direct chain access for tests: what the agent does, and what is really on chain. */
export interface Fixture {
  rpc_url: string;
  vault_id: string;
  token_id: string;
  owner_id: string;
  agent_id: string;
  agent_secret_key: string;
  api_id: string;
  mallory_id: string;
  demo_request_id: string;
}

export function fixture(): Fixture {
  const path = process.env.SPACT_FIXTURE;
  if (!path) throw new Error("SPACT_FIXTURE not set; run through playwright.config.ts");
  return JSON.parse(readFileSync(path, "utf8")) as Fixture;
}

export const UNIT = 1_000_000n;

export function chain(f: Fixture = fixture()) {
  const provider = new JsonRpcProvider({ url: f.rpc_url });
  const agent = new Account(f.agent_id, provider, f.agent_secret_key as KeyPairString);

  return {
    /** The agent asks for a payment, as its MCP tool would. */
    async agentRequests(requestId: string, amount: bigint, recipient: string, reason: string): Promise<void> {
      await agent.callFunction({
        contractId: f.vault_id,
        methodName: "request_direct_payment",
        args: { request_id: requestId, token: f.token_id, amount: amount.toString(), recipient, reason },
        gas: teraToGas("100"),
      });
    },
    async request(requestId: string): Promise<{ status: string; recipient: string } | null> {
      const r = await provider.callFunction<{ status: string; recipient: string }>({
        contractId: f.vault_id,
        method: "get_request",
        args: { request_id: requestId },
      });
      return r ?? null;
    },
    async balance(accountId: string): Promise<bigint> {
      const raw = await provider.callFunction<string>({ contractId: f.token_id, method: "ft_balance_of", args: { account_id: accountId } });
      if (typeof raw !== "string") throw new Error(`ft_balance_of returned ${String(raw)}`);
      return BigInt(raw);
    },
  };
}
