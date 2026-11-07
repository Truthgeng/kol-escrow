// Talks to the escrow contract. Reads use the RPC directly; writes are signed by the agent account,
// ideally with a function call key that can only call record_post, release and refund.

import { Account, JsonRpcProvider, teraToGas } from "near-api-js";

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
      });
    },
  };
}
