// Derives every testnet account name and key from one secret, KEY_SEED.
// The seed lives only in GitHub secrets, so no private key is ever printed or committed.

import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { baseEncode } from "near-api-js";

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

export function keyFromSeed(seed, label) {
  const priv32 = createHash("sha256").update(`${seed}:${label}`).digest();
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, priv32]), format: "der", type: "pkcs8" });
  const pub32 = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);
  return {
    secret: `ed25519:${baseEncode(Buffer.concat([priv32, pub32]))}`,
    publicKey: `ed25519:${baseEncode(pub32)}`,
  };
}

export function setup(seed = process.env.KEY_SEED) {
  if (!seed || seed.length < 24) throw new Error("KEY_SEED secret is missing or shorter than 24 characters");
  const tag = createHash("sha256").update(seed).digest("hex").slice(0, 6);
  const name = (role) => `kol${role}-${tag}.testnet`;
  return {
    network: "testnet",
    accounts: {
      // v2: storage deposits and the campaign start check. v1 stays on testnet as history.
      escrow: { id: name("escrow2"), ...keyFromSeed(seed, "escrow-v2") },
      token: { id: name("tusdc"), ...keyFromSeed(seed, "token") },
      agent: { id: name("agent2"), ...keyFromSeed(seed, "agent-full-v2") },
      project: { id: name("project"), ...keyFromSeed(seed, "demo-project") },
      kolA: { id: name("kola"), ...keyFromSeed(seed, "demo-kol-a") },
      kolB: { id: name("kolb"), ...keyFromSeed(seed, "demo-kol-b") },
    },
    // The only key the agent runs with: can call record_post, release, refund on the escrow. Nothing else.
    agentCallKey: keyFromSeed(seed, "agent-call-v2"),
  };
}
