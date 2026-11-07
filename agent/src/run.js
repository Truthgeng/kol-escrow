// One pass of the agent: look at every open deal, check X, act on-chain.
// Run it on a schedule (the repo's GitHub workflow runs it every 15 minutes).
//
//   node src/run.js            check and send transactions
//   DRY_RUN=1 node src/run.js  check and print what it would do, send nothing

import { decide, botShare } from "./decide.js";
import { makeX } from "./x.js";
import { makeJudge } from "./judge.js";
import { makeChain } from "./chain.js";

const env = process.env;
// On testnet the whole setup can come from one secret, KEY_SEED (see scripts/keys.js).
const derived = !env.ESCROW_CONTRACT && env.KEY_SEED ? (await import("../scripts/keys.js")).setup() : null;
const cfg = {
  network: env.NEAR_NETWORK || "testnet",
  contractId: derived ? derived.accounts.escrow.id : required("ESCROW_CONTRACT"),
  agentId: derived ? derived.accounts.agent.id : env.AGENT_ACCOUNT,
  agentKey: derived ? derived.agentCallKey.secret : env.AGENT_PRIVATE_KEY,
  dryRun: env.DRY_RUN === "1",
  xMode: env.X_MODE || "api",
  maxBotShare: Number(env.MAX_BOT_SHARE || 0.6),
  replySample: Number(env.REPLY_SAMPLE || 30),
};

const chain = makeChain(cfg);
const x = makeX({ mode: cfg.xMode, bearer: env.X_BEARER_TOKEN, fixturePath: env.X_FIXTURE || "fixtures/posts.json" });
const judge = makeJudge({ apiKey: env.NEARAI_API_KEY, model: env.NEARAI_MODEL || "zai-org/GLM-4.6" });

const nowNs = BigInt(Date.now()) * 1_000_000n;
const open = await chain.allOpenDeals();
log(`${open.length} open deal(s) on ${cfg.contractId} (${cfg.network})${cfg.dryRun ? ", dry run" : ""}`);

let failures = 0;
for (const { campaign, deal } of open) {
  try {
    await handle(campaign, deal);
  } catch (e) {
    failures++;
    log(`deal ${deal.id}: error: ${e.message}`);
  }
}
if (failures) process.exitCode = 1;

async function handle(campaign, deal) {
  let seen = {};
  let judgement = null;

  if (deal.state === "Pending") {
    // Only posts made after the campaign was created count. X recent search covers the last 7 days.
    const startedMs = Number(BigInt(campaign.created_at || 0) / 1_000_000n);
    const since = new Date(Math.max(Date.now() - 6.9 * 86_400_000, startedMs)).toISOString();
    const candidate = await x.findPost(deal.kol_handle, campaign.required_text, since);
    seen.candidate = candidate;
    if (candidate) {
      judgement = await judge({ title: campaign.title, requiredText: campaign.required_text, postText: candidate.text });
    }
  } else if (deal.state === "Posted") {
    seen.live = await x.isLive(deal.post_id);
    const holdEnd = BigInt(deal.posted_at) + BigInt(campaign.hold_secs) * 1_000_000_000n;
    if (seen.live && nowNs >= holdEnd) {
      seen.botShare = botShare(await x.replies(deal.post_id, cfg.replySample), Date.now());
    }
  }

  const step = decide({ deal, campaign, nowNs, seen, judgement, rules: { maxBotShare: cfg.maxBotShare } });
  log(`deal ${deal.id} @${deal.kol_handle}: ${step.action} (${step.reason})`);
  if (step.action === "wait" || cfg.dryRun) return;

  const attestation = step.action === "record_post" ? judgement.attestation : "rules:v1";
  await chain.call(step.action, { ...step.args, reason: step.reason.slice(0, 500), attestation });
  log(`deal ${deal.id}: ${step.action} sent`);
}

function required(name) {
  if (!env[name]) {
    console.error(`${name} is not set. See agent/.env.example`);
    process.exit(2);
  }
  return env[name];
}

function log(s) {
  console.log(`[${new Date().toISOString()}] ${s}`);
}
