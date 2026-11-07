import { oneclick, send } from "./_oneclick.js";

// Stablecoins 1Click can deliver, trimmed to what the payout panel needs.
export default async function handler(req, res) {
  const { status, body } = await oneclick("/tokens");
  if (status < 200 || status > 299 || !Array.isArray(body)) return send(res, 502, { error: "Couldn't load the token list from NEAR Intents" });
  const keep = body
    .filter((t) => ["USDC", "USDT"].includes(String(t.symbol).toUpperCase()))
    .map((t) => ({ assetId: t.assetId, symbol: t.symbol, blockchain: t.blockchain, decimals: t.decimals, contractAddress: t.contractAddress }));
  send(res, 200, keep, 600);
}
