// Talks to the escrow contract. Reads use the RPC directly; writes are signed by the agent account,
// ideally with a function call key that can only call record_post, release and refund.

import { Account, JsonRpcProvider, KeyPair, teraToGas } from "near-api-js";

const RPC = {
  testnet: "https://test.rpc.fastnear.com",
  mainnet: "https://free.rpc.fastnear.com",
};

export function makeChain({ network, contractId, agentId, agentKey }) {
  const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL || RPC[network] });
  const account = agentKey ? new Account(agentId, provider, agentKey) : null;

  const view = (method, args = {}) => provider.callFunction({ contractId, method, args });

  return {
    view,
    /**
     * Refuses to act with a key that has full access to the agent account. The agent must sign with
     * a function call key that can only call record_post, release and refund on this escrow, so a
     * leaked agent key can't move funds anywhere else or add keys. Returns the key's permission.
     */
    async assertLimitedKey() {
      if (!agentKey) return null;
      const publicKey = KeyPair.fromString(agentKey).getPublicKey().toString();
      const k = await provider.viewAccessKey({ accountId: agentId, publicKey });
      const p = k.permission;
      if (p === "FullAccess" || p?.FullAccess !== undefined) {
        throw new Error(`Refusing to run: the agent key on ${agentId} has full access. Use a function call key.`);
      }
      const fc = p.FunctionCall;
      if (fc.receiver_id !== contractId) throw new Error(`Refusing to run: the agent key is scoped to ${fc.receiver_id}, not ${contractId}`);
      const allowed = new Set(["record_post", "release", "refund"]);
      if (!fc.method_names.length || fc.method_names.some((m) => !allowed.has(m))) {
        throw new Error(`Refusing to run: the agent key allows ${fc.method_names.join(", ") || "every method"}`);
      }
      return fc;
    },
    async allOpenDeals() {
      const out = [];
      for (let from = 0; ; from += 50) {
        const page = await view("list_campaigns", { from, limit: 50 });
        for (const c of page) {
          const deals = await view("get_campaign_deals", { campaign_id: c.id });
          for (const d of deals) if (d.state === "Pending" || d.state === "Posted") out.push({ campaign: c, deal: d });
        }
        if (page.length < 50) break;
      }
      return out;
    },
    async call(methodName, args) {
      if (!account) throw new Error("AGENT_PRIVATE_KEY is missing, cannot send transactions");
      return account.callFunction({
        contractId,
        methodName,
        args,
        gas: teraToGas("80"),
        deposit: 0n,
        waitUntil: "FINAL",
      });
    },
  };
}
