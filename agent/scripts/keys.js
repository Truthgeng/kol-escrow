// Derives every testnet account name and key from one secret, KEY_SEED.
// The seed lives only in GitHub secrets, so no private key is ever printed or committed.

import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { baseEncode, keyToImplicitAddress } from "near-api-js";

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
      // v4: KOLs submit their own post. Earlier versions stay on testnet as history.
      escrow: { id: name("escrow4"), ...keyFromSeed(seed, "escrow-v4") },
      token: { id: name("tusdc"), ...keyFromSeed(seed, "token") },
      agent: { id: name("agent4"), ...keyFromSeed(seed, "agent-full-v4") },
      project: { id: name("project"), ...keyFromSeed(seed, "demo-project") },
      kolA: { id: name("kola"), ...keyFromSeed(seed, "demo-kol-a") },
      kolB: { id: name("kolb"), ...keyFromSeed(seed, "demo-kol-b") },
    },
    // The only key the agent runs with: can call record_post, release, refund on the escrow. Nothing else.
    agentCallKey: keyFromSeed(seed, "agent-call-v4"),
  };
}

// Mainnet: implicit accounts (64-character hex ids), which come into existence when someone sends
// NEAR to them. The owner funds the escrow address from their own wallet; nothing else is needed.
export const MAINNET_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"; // native USDC on NEAR

export function mainnet(seed = process.env.KEY_SEED) {
  if (!seed || seed.length < 24) throw new Error("KEY_SEED secret is missing or shorter than 24 characters");
  const implicit = (label) => {
    const k = keyFromSeed(seed, label);
    return { id: keyToImplicitAddress(k.publicKey), ...k };
  };
  return {
    network: "mainnet",
    token: MAINNET_USDC,
    accounts: { escrow: implicit("mainnet-escrow-v1"), agent: implicit("mainnet-agent-v1") },
    agentCallKey: keyFromSeed(seed, "mainnet-agent-call-v1"),
  };
}
