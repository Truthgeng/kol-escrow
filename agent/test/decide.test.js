import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, botShare } from "../src/decide.js";
import { makeX, postTimeMs, parseOembed } from "../src/x.js";
import { rulesJudge } from "../src/judge.js";

const S = 1_000_000_000n;
const DAY = 86_400n * S;
const rules = { maxBotShare: 0.6 };
const campaign = { created_at: DAY.toString(), deadline: (10n * DAY).toString(), hold_secs: (7 * 86_400).toString(), title: "Launch", required_text: "#Launch" };
const pending = { id: 0, state: "Pending", kol_handle: "alice" };
const posted = { id: 0, state: "Posted", kol_handle: "alice", post_id: "1", posted_at: (2n * DAY).toString() };
const post = (over = {}) => ({ id: "1", text: "gm #Launch", createdAtNs: 2n * DAY, authorHandle: "alice", ...over });

test("records a post that meets the terms", () => {
  const r = decide({ deal: pending, campaign, nowNs: 3n * DAY, seen: { candidate: post() }, judgement: { meetsTerms: true, reason: "ok" }, rules });
  assert.equal(r.action, "record_post");
  assert.equal(r.args.post_id, "1");
});

test("ignores a post made before the campaign started", () => {
  const r = decide({ deal: pending, campaign, nowNs: 3n * DAY, seen: { candidate: post({ createdAtNs: DAY / 2n }) }, judgement: { meetsTerms: true }, rules });
  assert.equal(r.action, "wait");
});

test("ignores a post by someone else", () => {
  const r = decide({ deal: pending, campaign, nowNs: 3n * DAY, seen: { candidate: post({ authorHandle: "mallory" }) }, judgement: { meetsTerms: true }, rules });
  assert.equal(r.action, "wait");
});

test("waits while the KOL still has time", () => {
  const r = decide({ deal: pending, campaign, nowNs: 3n * DAY, seen: { candidate: null }, rules });
  assert.equal(r.action, "wait");
});

test("refunds when nothing was posted by the deadline", () => {
  const r = decide({ deal: pending, campaign, nowNs: 11n * DAY, seen: { candidate: null }, rules });
  assert.equal(r.action, "refund");
});

test("refunds after the deadline when the only post failed the terms", () => {
  const r = decide({ deal: pending, campaign, nowNs: 11n * DAY, seen: { candidate: post() }, judgement: { meetsTerms: false, reason: "off topic" }, rules });
  assert.equal(r.action, "refund");
  assert.match(r.reason, /off topic/);
});

test("refunds when the post is deleted during the hold window", () => {
  const r = decide({ deal: posted, campaign, nowNs: 4n * DAY, seen: { live: false }, rules });
  assert.equal(r.action, "refund");
  assert.match(r.reason, /deleted/);
});

test("refunds when the post is edited to drop the required text", () => {
  const r = decide({ deal: posted, campaign, nowNs: 4n * DAY, seen: { live: true, text: "gm, nothing to see here" }, rules });
  assert.equal(r.action, "refund");
  assert.match(r.reason, /edited/);
});

test("keeps holding when the edited post still has the required text", () => {
  const r = decide({ deal: posted, campaign, nowNs: 4n * DAY, seen: { live: true, text: "gm (edited) #LAUNCH" }, rules });
  assert.equal(r.action, "wait");
});

test("waits during the hold window", () => {
  const r = decide({ deal: posted, campaign, nowNs: 5n * DAY, seen: { live: true }, rules });
  assert.equal(r.action, "wait");
});

test("releases after the hold window", () => {
  const r = decide({ deal: posted, campaign, nowNs: 9n * DAY, seen: { live: true, botShare: 0.1 }, rules });
  assert.equal(r.action, "release");
});

test("refunds when replies are mostly bots", () => {
  const r = decide({ deal: posted, campaign, nowNs: 9n * DAY, seen: { live: true, botShare: 0.8 }, rules });
  assert.equal(r.action, "refund");
  assert.match(r.reason, /80%/);
});

test("bot share flags new accounts, low followers and copy-paste replies", () => {
  const now = Date.parse("2026-11-10T00:00:00Z");
  const old = Date.parse("2020-01-01T00:00:00Z");
  const real = { authorCreatedAtMs: old, authorFollowers: 500 };
  const replies = [
    { ...real, text: "nice" },
    { ...real, text: "how do I join" },
    { text: "a", authorCreatedAtMs: Date.parse("2026-11-05T00:00:00Z"), authorFollowers: 300 },
    { text: "b", authorCreatedAtMs: old, authorFollowers: 1 },
    { ...real, text: "LFG @x" },
    { ...real, text: "lfg" },
  ];
  assert.equal(botShare(replies, now), 4 / 6);
  assert.equal(botShare(replies.slice(0, 3), now), null);
});

test("fixture X source and rule judge work end to end", async () => {
  const x = makeX({ mode: "fixture", fixturePath: new URL("../fixtures/posts.json", import.meta.url).pathname });
  const p = await x.findPost({ handle: "alice", requiredText: "#KolEscrowLaunch" });
  assert.equal(p.id, "1855000000000000001");
  assert.equal(await x.isLive(p.id), true);
  assert.equal(await x.isLive("1855000000000000002"), false);
  assert.equal(await x.findPost({ handle: "bob", requiredText: "#KolEscrowLaunch" }), null);
  assert.equal((await x.findPost({ handle: "alice", requiredText: "x", claimedId: "1855000000000000001" })).id, "1855000000000000001");
  const j = await rulesJudge({ requiredText: "#KolEscrowLaunch", postText: p.text });
  assert.equal(j.meetsTerms, true);
  assert.equal(j.attestation, "rules:v1");
  const share = botShare(await x.replies(p.id), Date.parse("2026-11-16T00:00:00Z"));
  assert.ok(share < 0.6);
});

test("post time is read from the post id", () => {
  const ms = Date.parse("2026-11-07T12:34:56.789Z");
  const id = ((BigInt(ms) - 1288834974657n) << 22n) | 123456n; // worker and sequence bits
  assert.equal(postTimeMs(id.toString()), ms);
});

test("oEmbed response gives the real author and plain text", () => {
  const body = {
    author_url: "https://twitter.com/alice",
    html: '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">Locked payouts &amp; no chasing<br>projects <a href="https://twitter.com/hashtag/KolEscrow?src=hash">#KolEscrow</a></p>&mdash; Alice (@alice) <a href="https://twitter.com/alice/status/1">November 7, 2026</a></blockquote>',
  };
  const p = parseOembed(body);
  assert.equal(p.handle, "alice");
  assert.equal(p.text, "Locked payouts & no chasing\nprojects #KolEscrow");
});
