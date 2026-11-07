// Live end-to-end test on testnet. Uses fixture X data so it costs nothing.
//
// KOL A posts and keeps it up       -> paid 100 tUSDC
// KOL B posts, then deletes it      -> project refunded 100 tUSDC
//
// Prints each step and fails loudly if a balance is wrong.

import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Account, JsonRpcProvider, teraToGas, nearToYocto } from "near-api-js";
import { setup } from "./keys.js";

const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL || "https://test.rpc.fastnear.com" });
const cfg = setup();
const A = cfg.accounts;
const project = new Account(A.project.id, provider, A.project.secret);
const HOLD = 60;
const tag = `#KolEscrowTest${Date.now().toString(36)}`;
const fee = 100_000_000n; // 100 tUSDC
const view = (contractId, method, args) => provider.callFunction({ contractId, method, args });
const bal = async (id) => BigInt(await view(A.token.id, "ft_balance_of", { account_id: id }));
const call = (contractId, methodName, args, deposit = 0n) =>
  // Wait for finality so the views that follow see this call's result, including its callbacks.
  project.callFunction({ contractId, methodName, args, gas: teraToGas("100"), deposit, waitUntil: "FINAL" });

step("1. Project mints 200 tUSDC and creates a campaign");
await call(A.token.id, "mint", { account_id: A.project.id, amount: (2n * fee).toString() });
const before = { project: await bal(A.project.id), kolA: await bal(A.kolA.id), kolB: await bal(A.kolB.id) };
const deadline = BigInt(Date.now() + 10 * 60_000) * 1_000_000n;
const campaignId = await call(A.escrow.id, "create_campaign", {
  token: A.token.id,
  title: "E2E test campaign",
  required_text: tag,
  deadline: deadline.toString(),
  hold_secs: String(HOLD),
}, nearToYocto("0.01"));
info(`campaign ${campaignId}, required text ${tag}, hold ${HOLD}s`);

step("2. Project funds the escrow and locks 100 tUSDC per KOL");
await call(A.token.id, "ft_transfer_call", {
  receiver_id: A.escrow.id,
  amount: (2n * fee).toString(),
  msg: JSON.stringify({ campaign_id: campaignId }),
}, 1n);
const dealA = await call(A.escrow.id, "add_deal", { campaign_id: campaignId, kol_handle: "kol_a_demo", kol_account: A.kolA.id, fee: fee.toString() }, nearToYocto("0.025"));
const dealB = await call(A.escrow.id, "add_deal", { campaign_id: campaignId, kol_handle: "kol_b_demo", kol_account: A.kolB.id, fee: fee.toString() }, nearToYocto("0.025"));

step("2b. Storage rules: a deal with no storage deposit is refused");
let refused = false;
try { await call(A.escrow.id, "add_deal", { campaign_id: campaignId, kol_handle: "spam", kol_account: A.kolB.id, fee: "1" }); } catch { refused = true; }
expect(refused, "add_deal without a storage deposit fails"); 
expect((await bal(A.project.id)) === before.project - 2n * fee, "project paid 200 into escrow");

step("3. Both KOLs post. Agent confirms both posts on-chain");
// Posted a few seconds after the campaign started (the contract rejects older posts).
const camp = await view(A.escrow.id, "get_campaign", { campaign_id: campaignId });
const postedAt = new Date(Math.min(Date.now() - 2_000, Number(BigInt(camp.created_at) / 1_000_000n) + 3_000)).toISOString();
const fixture = {
  posts: [
    { id: "9000000000000000001", handle: "kol_a_demo", text: `Locked payouts for KOLs ${tag}`, created_at: postedAt, deleted: false },
    { id: "9000000000000000002", handle: "kol_b_demo", text: `gm ${tag}`, created_at: postedAt, deleted: false },
  ],
  replies: {},
};
writeFileSync("e2e-fixture.json", JSON.stringify(fixture));
agentPass();
expect((await view(A.escrow.id, "get_deal", { deal_id: dealA })).state === "Posted", "deal A is Posted");
expect((await view(A.escrow.id, "get_deal", { deal_id: dealB })).state === "Posted", "deal B is Posted");

step("4. KOL B deletes the post. Agent refunds the project");
fixture.posts[1].deleted = true;
writeFileSync("e2e-fixture.json", JSON.stringify(fixture));
agentPass();
expect((await view(A.escrow.id, "get_deal", { deal_id: dealB })).state === "Refunded", "deal B is Refunded");

step(`5. Hold window ends (${HOLD}s). Agent pays KOL A`);
await new Promise((r) => setTimeout(r, (HOLD + 5) * 1000));
agentPass();
expect((await view(A.escrow.id, "get_deal", { deal_id: dealA })).state === "Released", "deal A is Released");

step("6. Final balances");
expect((await bal(A.kolA.id)) === before.kolA + fee, "KOL A received 100 tUSDC");
expect((await bal(A.kolB.id)) === before.kolB, "KOL B received nothing");
expect((await bal(A.project.id)) === before.project - fee, "project got 100 tUSDC back");
const d = await view(A.escrow.id, "get_deal", { deal_id: dealA });
for (const v of d.verdicts) info(`deal A verdict: ${v.action}: ${v.reason}`);
console.log(`\nAll checks passed. Campaign ${campaignId}: https://testnet.nearblocks.io/address/${A.escrow.id}`);

function agentPass() {
  const out = execFileSync("node", ["src/run.js"], {
    env: { ...process.env, X_MODE: "fixture", X_FIXTURE: "e2e-fixture.json", NEARAI_API_KEY: "" },
    encoding: "utf8",
  });
  for (const line of out.trim().split("\n")) info(`agent ${line.replace(/^\[[^\]]+\] /, "")}`);
}
function step(s) {
  console.log(`\n${s}`);
}
function info(s) {
  console.log(`   ${s}`);
}
function expect(ok, what) {
  if (!ok) {
    console.error(`   FAIL: ${what}`);
    process.exit(1);
  }
  console.log(`   ok: ${what}`);
}
