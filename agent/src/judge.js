// Judges whether a post meets the campaign terms.
//
// With NEARAI_API_KEY set, the check runs on NEAR AI Cloud, where inference happens inside a TEE.
// The agent then fetches the TEE's signature for that exact request and response and stores it
// on-chain with the verdict, so anyone can check the verdict came from that model run.
//
// Without a key, a plain rule check is used and the attestation says so. Nothing is faked.

import { createHash } from "node:crypto";

const BASE = "https://cloud-api.near.ai/v1";
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export function makeJudge({ apiKey, model }) {
  if (!apiKey) return rulesJudge;
  return (input) => nearAiJudge(input, apiKey, model);
}

async function rulesJudge({ requiredText, postText }) {
  const ok = postText.toLowerCase().includes(requiredText.toLowerCase());
  return {
    meetsTerms: ok,
    reason: ok ? `Post contains "${requiredText}"` : `Post is missing "${requiredText}"`,
    attestation: "rules:v1",
  };
}

async function nearAiJudge({ title, requiredText, postText }, apiKey, model) {
  const reqBody = JSON.stringify({
    model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You check sponsored posts for a KOL campaign. Reply with JSON only: " +
          '{"meets_terms": true|false, "reason": "<one short sentence>"}. ' +
          "A post meets the terms only if it includes the required text and is genuinely about the campaign, " +
          "not a reply, joke or unrelated post that happens to contain the text.",
      },
      {
        role: "user",
        content: `Campaign: ${title}\nRequired text: ${requiredText}\nPost:\n"""${postText}"""`,
      },
    ],
  });

  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: reqBody,
  });
  const resText = await res.text();
  if (!res.ok) throw new Error(`NEAR AI ${res.status}: ${resText.slice(0, 300)}`);
  const out = JSON.parse(resText);

  let verdict;
  try {
    verdict = JSON.parse(out.choices[0].message.content);
  } catch {
    throw new Error("NEAR AI reply was not JSON: " + String(out.choices?.[0]?.message?.content).slice(0, 200));
  }
  // The model can say yes, but the required text must actually be there.
  const hasText = postText.toLowerCase().includes(requiredText.toLowerCase());
  const meetsTerms = Boolean(verdict.meets_terms) && hasText;
  const reason = String(verdict.reason || "").slice(0, 300) +
    (verdict.meets_terms && !hasText ? ` (overridden: missing "${requiredText}")` : "");

  return { meetsTerms, reason, attestation: await attest(out.id, model, reqBody, resText, apiKey) };
}

/**
 * Fetches the TEE signature for this chat and checks its signed text covers our exact request and
 * response hashes. It does not verify the signature itself or pin NEAR AI's signing address: the
 * signature is stored on-chain so anyone can verify it later. The site labels it "not verified".
 * Format stored on-chain: nearai:<chat_id>:<signing_address>:<signature>
 */
async function attest(chatId, model, reqBody, resText, apiKey) {
  try {
    const url = `${BASE}/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return `nearai:${chatId}:unsigned`;
    const sig = await res.json();
    const expected = `${sha256(reqBody)}:${sha256(resText)}`;
    if (!String(sig.text || "").endsWith(expected)) return `nearai:${chatId}:mismatch`;
    return `nearai:${chatId}:${sig.signing_address}:${sig.signature}`.slice(0, 400);
  } catch {
    return `nearai:${chatId}:unsigned`;
  }
}

export { rulesJudge };
