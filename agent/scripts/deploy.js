// Sets up the whole testnet demo from one secret (KEY_SEED). Safe to run again: each step checks first.
//
// 1. Creates the accounts with the testnet faucet
// 2. Deploys the escrow and the tUSDC test token
// 3. Gives the agent a function call key that can only call record_post, release and refund
// 4. Removes the agent's full access key, so the agent account can't do anything else
//
// Usage: KEY_SEED=... ESCROW_WASM=path TOKEN_WASM=path node scripts/deploy.js

import { readFileSync, writeFileSync } from "node:fs";
import { Account, JsonRpcProvider, teraToGas, nearToYocto } from "near-api-js";
import { setup } from "./keys.js";

const FAUCET = process.env.FAUCET_URL || "https://helper.nearprotocol.com/account";
const GRACE_SECS = process.env.GRACE_SECS || "600"; // 10 minutes, short for the demo
const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL || "https://test.rpc.fastnear.com" });
const cfg = setup();
const A = cfg.accounts;
const acct = (a) => new Account(a.id, provider, a.secret);

for (const a of Object.values(A)) await ensureAccount(a);

await ensureCode(A.escrow, process.env.ESCROW_WASM);
await ensureCode(A.token, process.env.TOKEN_WASM);

if (!(await isInit(A.token.id, "ft_total_supply"))) {
  await acct(A.token).callFunction({ contractId: A.token.id, methodName: "new", args: {}, gas: teraToGas("30") });
  log("token initialised");
}
if (!(await isInit(A.escrow.id, "get_config"))) {
  await acct(A.escrow).callFunction({
    contractId: A.escrow.id,
    methodName: "new",
    args: { agent: A.agent.id, grace_secs: GRACE_SECS },
    gas: teraToGas("30"),
  });
  log(`escrow initialised, agent ${A.agent.id}, grace ${GRACE_SECS}s`);
}

// Agent keys
const keys = (await provider.viewAccessKeyList({ accountId: A.agent.id })).keys.map((k) => k.public_key);
if (!keys.includes(cfg.agentCallKey.publicKey)) {
  await acct(A.agent).addFunctionCallAccessKey({
    publicKey: cfg.agentCallKey.publicKey,
    contractId: A.escrow.id,
    methodNames: ["record_post", "release", "refund"],
    allowance: nearToYocto("5"),
  });
  log("agent function call key added");
}
if (keys.includes(A.agent.publicKey) && process.env.KEEP_AGENT_FULL_KEY !== "1") {
  await acct(A.agent).deleteKey(A.agent.publicKey);
  log("agent full access key removed");
}

const summary = {
  network: "testnet",
  escrow: A.escrow.id,
  token: A.token.id,
  agent: A.agent.id,
  demo: { project: A.project.id, kolA: A.kolA.id, kolB: A.kolB.id },
  agentKeyMethods: ["record_post", "release", "refund"],
  explorer: `https://testnet.nearblocks.io/address/${A.escrow.id}`,
};
writeFileSync("deployment.json", JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));

async function ensureAccount(a) {
  try {
    await provider.viewAccount({ accountId: a.id });
    return;
  } catch {}
  const res = await fetch(FAUCET, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newAccountId: a.id, newAccountPublicKey: a.publicKey }),
  });
  if (!res.ok) throw new Error(`Faucet refused ${a.id}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      await provider.viewAccount({ accountId: a.id });
      log(`created ${a.id}`);
      return;
    } catch {}
  }
  throw new Error(`${a.id} did not appear after faucet request`);
}

async function ensureCode(a, path) {
  if (!path) throw new Error(`No wasm path for ${a.id}`);
  const code = readFileSync(path);
  await acct(a).deployContract(new Uint8Array(code));
  log(`deployed ${path} to ${a.id} (${code.length} bytes)`);
}

async function isInit(contractId, method) {
  try {
    await provider.callFunction({ contractId, method, args: {} });
    return true;
  } catch {
    return false;
  }
}

function log(s) {
  console.log(`[deploy] ${s}`);
}
