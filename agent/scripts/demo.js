// Sets up and drives a live demo deal on testnet with a real X account, using the demo accounts
// derived from KEY_SEED. Nothing here is needed to use the product; it exists to record the demo.
//
//   node scripts/demo.js setup <x_handle> [hold_minutes]
//       creates a campaign requiring #KolEscrowDemo, funds it, and locks two deals for the handle:
//       deal A paid to the demo KOL A account, deal B paid to the demo KOL B account
//   node scripts/demo.js submit <deal_id> <post_url>
//       submits a post link from whichever demo KOL account owns the deal
//   node scripts/demo.js open [hold_minutes] [budget]
//       creates a campaign with an open budget and no deals, for the apply flow
//   node scripts/demo.js proof   prints the agent's keys and the escrow config
//   node scripts/demo.js show [campaign_id]
//       prints the state of every deal in the campaign (latest by default)

import { Account, JsonRpcProvider, KeyPair, teraToGas, nearToYocto } from "near-api-js";
import { setup as keys } from "./keys.js";

const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL || "https://test.rpc.fastnear.com" });
const A = keys().accounts;
const FEE = 50_000_000n; // 50 tUSDC
const TAG = "#KolEscrowDemo";
const view = (method, args) => provider.callFunction({ contractId: A.escrow.id, method, args });
const as = (a) => new Account(a.id, provider, a.secret);
const call = (who, contractId, methodName, args, deposit = 0n) =>
  as(who).callFunction({ contractId, methodName, args, gas: teraToGas("100"), deposit, waitUntil: "FINAL" });

const [cmd, ...rest] = (process.env.DEMO_COMMAND || process.argv.slice(2).join(" ")).trim().split(/\s+/);

if (cmd === "setup") {
  const handle = (rest[0] || "").replace(/^@/, "");
  const holdMin = Number(rest[1] || 10);
  if (!/^\w{1,15}$/.test(handle)) throw new Error("Give the X handle, like: setup heistruthX 10");
  await call(A.project, A.token.id, "mint", { account_id: A.project.id, amount: (2n * FEE).toString() });
  const id = await call(A.project, A.escrow.id, "create_campaign", {
    token: A.token.id,
    title: "KOL Escrow demo",
    required_text: TAG,
    deadline: ((BigInt(Date.now()) + 24n * 3_600_000n) * 1_000_000n).toString(),
    hold_secs: String(holdMin * 60),
  }, nearToYocto("0.01"));
  await call(A.project, A.token.id, "ft_transfer_call", { receiver_id: A.escrow.id, amount: (2n * FEE).toString(), msg: JSON.stringify({ campaign_id: id }) }, 1n);
  const dA = await call(A.project, A.escrow.id, "add_deal", { campaign_id: id, kol_handle: handle, kol_account: A.kolA.id, fee: FEE.toString() }, nearToYocto("0.025"));
  const dB = await call(A.project, A.escrow.id, "add_deal", { campaign_id: id, kol_handle: handle, kol_account: A.kolB.id, fee: FEE.toString() }, nearToYocto("0.025"));
  const c = await view("get_campaign", { campaign_id: id });
  console.log(`Campaign ${id} created at ${new Date(Number(BigInt(c.created_at) / 1_000_000n)).toISOString()}`);
  console.log(`Required text ${TAG}, hold ${holdMin} min, deadline in 24 hours`);
  console.log(`Deal ${dA}: @${handle}, 50 tUSDC to ${A.kolA.id} (the keep-it-up deal)`);
  console.log(`Deal ${dB}: @${handle}, 50 tUSDC to ${A.kolB.id} (the delete-it deal)`);
  console.log(`Posts must go up after the time above. Page: https://kol-escrow.vercel.app/#/c/${id}`);
} else if (cmd === "open") {
  // A campaign with an open budget and no deals yet, for recording the apply flow.
  const holdMin = Number(rest[0] || 10);
  const budget = BigInt(rest[1] || 150) * 1_000_000n;
  await call(A.project, A.token.id, "mint", { account_id: A.project.id, amount: budget.toString() });
  const id = await call(A.project, A.escrow.id, "create_campaign", {
    token: A.token.id,
    title: "Launch week on NEAR",
    required_text: TAG,
    deadline: ((BigInt(Date.now()) + 24n * 3_600_000n) * 1_000_000n).toString(),
    hold_secs: String(holdMin * 60),
  }, nearToYocto("0.01"));
  await call(A.project, A.token.id, "ft_transfer_call", { receiver_id: A.escrow.id, amount: budget.toString(), msg: JSON.stringify({ campaign_id: id }) }, 1n);
  console.log(`Campaign ${id} open with ${budget / 1_000_000n} tUSDC budget, hold ${holdMin} min. Page: https://kol-escrow.vercel.app/#/c/${id}`);
  console.log(`Project ${A.project.id}, applicant ${A.kolA.id}`);
} else if (cmd === "submit") {
  const dealId = Number(rest[0]);
  const m = /(?:x|twitter)\.com\/\w{1,15}\/status\/(\d{1,20})/i.exec(rest[1] || "");
  if (!Number.isInteger(dealId) || !m) throw new Error("Use: submit <deal_id> <post link>");
  const d = await view("get_deal", { deal_id: dealId });
  const who = [A.kolA, A.kolB].find((a) => a.id === d.kol_account);
  if (!who) throw new Error(`Deal ${dealId} isn't paid to a demo KOL account`);
  await call(who, A.escrow.id, "submit_post", { deal_id: dealId, post_id: m[1] });
  console.log(`Deal ${dealId}: post ${m[1]} submitted from ${who.id}`);
} else if (cmd === "show") {
  const id = rest[0] != null ? Number(rest[0]) : (await view("list_campaigns", { from: 0, limit: 50 })).at(-1).id;
  for (const d of await view("get_campaign_deals", { campaign_id: id })) {
    console.log(`Deal ${d.id} @${d.kol_handle}: ${d.state}, submitted ${d.claimed_post || "-"}, confirmed ${d.post_id || "-"}`);
    for (const v of d.verdicts) console.log(`   ${v.action}: ${v.reason}`);
  }
} else if (cmd === "proof") {
  // What the explorer would show, read straight from the network.
  const keys = (await provider.viewAccessKeyList({ accountId: A.agent.id })).keys;
  console.log(`Agent ${A.agent.id} has ${keys.length} access key(s):`);
  for (const k of keys) console.log(`   ${k.public_key.slice(0, 20)}... ${JSON.stringify(k.access_key.permission)}`);
  const cfg = await view("get_config", {});
  console.log(`Escrow ${A.escrow.id}: owner ${cfg[0]}, agent ${cfg[1]}, grace ${cfg[2]}s`);
  const code = await provider.viewContractCode({ contractId: A.escrow.id });
  console.log(`Escrow code: ${code.code.length} bytes, hash ${code.hash}`);
} else if (cmd === "exists") {
  // Asked of two independent testnet RPCs, plus mainnet, so a lagging node or the wrong network can't mislead.
  const rpcs = { "testnet (fastnear)": provider, "testnet (near.org)": new JsonRpcProvider({ url: "https://rpc.testnet.near.org" }), mainnet: new JsonRpcProvider({ url: "https://free.rpc.fastnear.com" }) };
  for (const id of rest) {
    for (const [name, p] of Object.entries(rpcs)) {
      const a = await p.viewAccount({ accountId: id }).catch((e) => ({ err: String(e.message || e).slice(0, 80) }));
      console.log(`${id} on ${name}: ${a.err ? `not found (${a.err})` : `exists, ${Number(BigInt(a.amount) / 10n ** 21n) / 1000} NEAR`}`);
    }
  }
} else if (cmd === "rules") {
  // Prints the hackathon's official rules file, to re-check them before submitting.
  const r = await fetch("https://nearhackathon.com/HACKATHON.md");
  console.log(`HTTP ${r.status}\n----- HACKATHON.md -----\n${await r.text()}\n----- end -----`);
} else if (cmd === "wallet-check") {
  // Does what the site's "Use a free test wallet" button does, against the live site.
  const site = rest[0] || "https://kol-escrow.vercel.app";
  const kp = KeyPair.fromRandom("ed25519");
  const id = rest[1] ? `${rest[1]}.testnet` : `kolguest-${Math.random().toString(36).slice(2, 12).padEnd(10, "0")}.testnet`;
  const r = await fetch(`${site}/api/faucet`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: id, publicKey: kp.getPublicKey().toString() }) });
  console.log(`faucet route: ${r.status} ${await r.text()}`);
  let acct = null;
  for (let i = 0; i < 20 && !acct; i++) {
    await new Promise((res) => setTimeout(res, 1500));
    acct = await provider.viewAccount({ accountId: id }).catch(() => null);
  }
  if (!acct) throw new Error(`${id} never appeared`);
  console.log(`${id} exists with ${Number(BigInt(acct.amount) / 10n ** 21n) / 1000} NEAR`);
  const a = new Account(id, provider, kp.toString());
  await a.callFunction({ contractId: A.token.id, methodName: "mint", args: { account_id: id, amount: "1000000" }, gas: teraToGas("30"), waitUntil: "FINAL" });
  console.log(`signed a mint from the new account: ${await view.call(null, "get_config", {}).then(() => "ok")}`);
} else {
  console.log("Commands: setup <x_handle> [hold_minutes] | submit <deal_id> <post_url> | show [campaign_id]");
  process.exit(2);
}
