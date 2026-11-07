// Mainnet deploy. Run in two steps:
//   1. Without funds: prints the escrow address to fund, then stops. Nothing is sent.
//   2. After the owner sends NEAR to that address: deploys and sets up everything.
//
// What step 2 does, in order (each step checks first, so it's safe to run again):
//   - sends a small amount of NEAR from the escrow to the agent's address, which creates it
//   - deploys the contract to the escrow and initialises it with that agent
//   - registers the escrow for storage on native USDC so it can hold and send it
//   - gives the agent a function call key limited to record_post, release and refund
//   - deletes the agent's full access key
//
// Usage: KEY_SEED=... ESCROW_WASM=path node scripts/deploy-mainnet.js

import { readFileSync, writeFileSync } from "node:fs";
import { Account, JsonRpcProvider, teraToGas, nearToYocto, yoctoToNear } from "near-api-js";
import { mainnet } from "./keys.js";

const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL || "https://free.rpc.fastnear.com" });
const cfg = mainnet();
const { escrow, agent } = cfg.accounts;
const code = readFileSync(process.env.ESCROW_WASM);
const GRACE_SECS = process.env.GRACE_SECS || "600";
const AGENT_FUND = nearToYocto("0.05");
// Contract bytes, plus room for the account itself, its state and the USDC registration.
const NEED = BigInt(code.length) * 10n ** 19n + nearToYocto("0.06");

const summary = { network: "mainnet", escrow: escrow.id, agent: agent.id, token: cfg.token, explorer: `https://nearblocks.io/address/${escrow.id}` };
const write = (extra) => writeFileSync("deployment-mainnet.json", JSON.stringify({ ...summary, ...extra }, null, 2) + "\n");
const exists = async (id) => provider.viewAccount({ accountId: id }).then(() => true, () => false);
const balance = async (id) => BigInt((await provider.viewAccount({ accountId: id })).amount);

log(`escrow address: ${escrow.id}`);
log(`agent address:  ${agent.id}`);
log(`contract size:  ${code.length} bytes, needs about ${yoctoToNear(NEED, 3)} NEAR in the escrow`);

if (!(await exists(escrow.id))) {
  write({ status: "waiting for funds", send: `${yoctoToNear(NEED + AGENT_FUND, 2)} NEAR`, to: escrow.id });
  log(`NOT FUNDED YET. Send ${yoctoToNear(NEED + AGENT_FUND, 2)} NEAR to ${escrow.id}, then run this again.`);
  process.exit(0);
}
const have = await balance(escrow.id);
const agentReady = await exists(agent.id);
if (have < NEED + (agentReady ? 0n : AGENT_FUND)) {
  write({ status: "not enough funds", has: yoctoToNear(have, 3), needs: yoctoToNear(NEED + AGENT_FUND, 3) });
  log(`Escrow has ${yoctoToNear(have, 3)} NEAR, needs ${yoctoToNear(NEED + (agentReady ? 0n : AGENT_FUND), 3)}. Top it up and run again.`);
  process.exit(0);
}

const esc = new Account(escrow.id, provider, escrow.secret);

if (!agentReady) {
  await esc.transfer({ receiverId: agent.id, amount: AGENT_FUND });
  log(`sent 0.05 NEAR to the agent, which creates its account`);
}

const deployed = await provider.viewContractCode({ contractId: escrow.id }).then((c) => c && c.code_base64 && c.code_base64.length > 0, () => false);
if (!deployed) {
  await esc.deployContract(new Uint8Array(code));
  log(`deployed ${code.length} bytes to ${escrow.id}`);
} else {
  log("contract already deployed, leaving it as it is");
}

const isInit = await provider.callFunction({ contractId: escrow.id, method: "get_config", args: {} }).then(() => true, () => false);
if (!isInit) {
  await esc.callFunction({ contractId: escrow.id, methodName: "new", args: { agent: agent.id, grace_secs: GRACE_SECS }, gas: teraToGas("30") });
  log(`initialised, agent ${agent.id}, grace ${GRACE_SECS}s`);
}

const reg = await provider.callFunction({ contractId: cfg.token, method: "storage_balance_of", args: { account_id: escrow.id } });
if (!reg) {
  await esc.callFunction({ contractId: cfg.token, methodName: "storage_deposit", args: { account_id: escrow.id, registration_only: true }, gas: teraToGas("30"), deposit: nearToYocto("0.00125") });
  log("escrow registered on USDC");
}

const ag = new Account(agent.id, provider, agent.secret);
const keys = (await provider.viewAccessKeyList({ accountId: agent.id })).keys.map((k) => k.public_key);
if (!keys.includes(cfg.agentCallKey.publicKey)) {
  await ag.addFunctionCallAccessKey({
    publicKey: cfg.agentCallKey.publicKey,
    contractId: escrow.id,
    methodNames: ["record_post", "release", "refund"],
    allowance: nearToYocto("0.04"),
  });
  log("agent function call key added");
}
if (keys.includes(agent.publicKey)) {
  await ag.deleteKey(agent.publicKey);
  log("agent full access key removed");
}

write({ status: "live", escrowBalance: yoctoToNear(await balance(escrow.id), 3) });
log(`LIVE: ${summary.explorer}`);

function log(s) {
  console.log(`[mainnet] ${s}`);
}
