import { oneclick, send } from "./_oneclick.js";

// Builds a 1Click quote for paying out a KOL: EXACT_INPUT from NEAR to another chain.
// Only these fields are accepted, so the route can't be used as an open relay for anything else.
// GET with the same params works too (dry runs only), which makes it easy to check from a browser.
const ID = /^[\w.:-]{3,200}$/;

export default async function handler(req, res) {
  const q = req.method === "POST" ? (typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {}) : req.query;
  const dry = req.method !== "POST" || q.dry !== false;
  const { originAsset, destinationAsset, amount, refundTo, recipient } = q;
  if (![originAsset, destinationAsset].every((a) => ID.test(a || ""))) return send(res, 400, { error: "Pick a token to receive" });
  if (!/^\d{1,40}$/.test(amount || "")) return send(res, 400, { error: "Amount must be a whole number in the token's smallest unit" });
  if (!/^[a-z0-9._-]{2,64}$/.test(refundTo || "")) return send(res, 400, { error: "Refund account must be a NEAR account" });
  if (!recipient || String(recipient).length > 120) return send(res, 400, { error: "Enter the address that should receive the payout" });

  const request = {
    dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset,
    amount,
    refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: String(recipient),
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
    referral: "kolescrow",
    quoteWaitingTimeMs: 3000,
  };
  const { status, body } = await oneclick("/quote", { method: "POST", body: JSON.stringify(request) });
  if (status !== 200) return send(res, status === 401 ? 502 : status, { error: body?.message || "NEAR Intents couldn't quote this route" });
  send(res, 200, body);
}
