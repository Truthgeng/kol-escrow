// Creates a free testnet account for the built-in test wallet, through NEAR's public testnet helper.
// Only names the site itself generates are allowed, and only on testnet, so this can't be used
// to claim arbitrary names. The private key never leaves the visitor's browser: only the public key comes here.

const HELPER = process.env.TESTNET_HELPER_URL || "https://helper.nearprotocol.com/account";
const NAME = /^kolguest-[a-z0-9]{10}\.testnet$/;
const KEY = /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/;

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).send(JSON.stringify({ error: "POST only" }));
  const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  if (!NAME.test(b.accountId || "") || !KEY.test(b.publicKey || "")) {
    return res.status(400).send(JSON.stringify({ error: "Bad account name or key" }));
  }
  const r = await fetch(HELPER, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newAccountId: b.accountId, newAccountPublicKey: b.publicKey }),
  }).catch((e) => ({ ok: false, status: 502, text: async () => e.message }));
  if (!r.ok) {
    const t = (await r.text()).slice(0, 200);
    return res.status(502).send(JSON.stringify({ error: `The testnet faucet said no (${r.status}). ${t}`.trim() }));
  }
  res.status(200).send(JSON.stringify({ ok: true, accountId: b.accountId }));
}
