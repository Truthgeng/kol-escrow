// Pure decision logic. No network calls here, so it is easy to test.
//
// Input: one deal, its campaign, the current time, and what the agent saw on X.
// Output: the single contract call to make next, or a "wait".

export const SEC_NS = 1_000_000_000n;

/**
 * @param {object} p
 * @param {object} p.deal       deal from the contract (get_campaign_deals)
 * @param {object} p.campaign   campaign from the contract
 * @param {bigint} p.nowNs      current time in nanoseconds
 * @param {object} p.seen       what X showed:
 *   - for a Pending deal: { candidate: {id, text, createdAtNs, authorHandle} | null }
 *   - for a Posted deal:  { live: boolean, botShare: number | null }
 * @param {object} p.judgement  { meetsTerms: boolean, reason: string } for the candidate post (Pending only)
 * @param {object} p.rules      { maxBotShare: number }
 */
export function decide({ deal, campaign, nowNs, seen, judgement, rules }) {
  const deadline = BigInt(campaign.deadline);
  const holdNs = BigInt(campaign.hold_secs) * SEC_NS;

  if (deal.state === "Pending") {
    const c = seen?.candidate;
    const started = BigInt(campaign.created_at || 0);
    if (c && c.authorHandle?.toLowerCase() === deal.kol_handle && c.createdAtNs <= deadline && c.createdAtNs >= started) {
      if (judgement?.meetsTerms) {
        return {
          action: "record_post",
          args: { deal_id: deal.id, post_id: c.id, posted_at: c.createdAtNs.toString() },
          reason: judgement.reason,
        };
      }
    }
    if (nowNs > deadline) {
      const why = c && judgement && !judgement.meetsTerms
        ? `Post ${c.id} did not meet the terms: ${judgement.reason}`
        : "No post matching the terms went up before the deadline";
      return { action: "refund", args: { deal_id: deal.id }, reason: why };
    }
    return { action: "wait", reason: "Waiting for the KOL to post" };
  }

  if (deal.state === "Posted") {
    if (seen && seen.live === false) {
      return {
        action: "refund",
        args: { deal_id: deal.id },
        reason: `Post ${deal.post_id} was deleted before the hold window ended`,
      };
    }
    const holdEnd = BigInt(deal.posted_at) + holdNs;
    if (nowNs < holdEnd) {
      return { action: "wait", reason: "Hold window still running" };
    }
    if (seen?.botShare != null && seen.botShare >= rules.maxBotShare) {
      const pct = Math.round(seen.botShare * 100);
      return {
        action: "refund",
        args: { deal_id: deal.id },
        reason: `${pct}% of sampled replies look like bots (limit ${Math.round(rules.maxBotShare * 100)}%)`,
      };
    }
    const bot = seen?.botShare == null ? "" : `, ${Math.round(seen.botShare * 100)}% of sampled replies flagged`;
    return {
      action: "release",
      args: { deal_id: deal.id },
      reason: `Post ${deal.post_id} stayed up for the full hold window${bot}`,
    };
  }

  return { action: "wait", reason: `Deal is ${deal.state}` };
}

/**
 * Scores a sample of reply authors. A reply counts as suspicious when the author is very new,
 * has almost no followers, or posted the exact same text as another reply.
 * Returns a share between 0 and 1, or null when there are too few replies to judge.
 */
export function botShare(replies, nowMs, minSample = 5) {
  if (!replies || replies.length < minSample) return null;
  const seenText = new Map();
  for (const r of replies) {
    const t = (r.text || "").replace(/@\w+/g, "").trim().toLowerCase();
    seenText.set(t, (seenText.get(t) || 0) + 1);
  }
  let flagged = 0;
  for (const r of replies) {
    const ageDays = r.authorCreatedAtMs ? (nowMs - r.authorCreatedAtMs) / 86_400_000 : 9999;
    const followers = r.authorFollowers ?? 9999;
    const t = (r.text || "").replace(/@\w+/g, "").trim().toLowerCase();
    const duplicate = t.length > 0 && seenText.get(t) > 1;
    if (ageDays < 30 || followers < 5 || duplicate) flagged++;
  }
  return flagged / replies.length;
}
