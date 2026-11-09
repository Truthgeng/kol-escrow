// Upgrades the live testnet escrow in place: deploys the new code and runs `migrate` in one
// transaction, so every existing campaign and deal (including the recorded demo) stays.
// Safe to run again: if the contract already has applications, it only redeploys the code.
//
// Usage: KEY_SEED=... ESCROW_WASM=path node scripts/upgrade.js

import { readFileSync } from "node:fs";
import { Account, JsonRpcProvider, actions, teraToGas } from "near-api-js";
import { setup } from "./keys.js";

const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL || "https://test.rpc.fastnear.com" });
const { escrow } = setup().accounts;
const code = new Uint8Array(readFileSync(process.env.ESCROW_WASM));
const view = (method, args = {}) => provider.callFunction({ contractId: escrow.id, method, args });

const before = await view("list_campaigns", { from: 0, limit: 50 });
const hasApps = await view("get_campaign_applications", { campaign_id: 0 }).then(() => true, () => false);

const acts = [actions.deployContract(code)];
if (!hasApps) acts.push(actions.functionCall("migrate", {}, teraToGas("50"), 0n));
await new Account(escrow.id, provider, escrow.secret).signAndSendTransaction({
  receiverId: escrow.id,
  actions: acts,
  waitUntil: "FINAL",
});
console.log(`[upgrade] deployed ${code.length} bytes to ${escrow.id}${hasApps ? " (already migrated)" : " and migrated"}`);

const after = await view("list_campaigns", { from: 0, limit: 50 });
if (after.length !== before.length) throw new Error(`Campaign count changed: ${before.length} -> ${after.length}`);
await view("get_campaign_applications", { campaign_id: 0 });
const deals = await view("get_campaign_deals", { campaign_id: after.at(-1).id });
console.log(`[upgrade] ${after.length} campaigns kept; latest campaign has ${deals.length} deal(s): ${deals.map((d) => `${d.id}=${d.state}`).join(", ")}`);
