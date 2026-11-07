// Reads posts from X. Three sources:
// - "oembed" (default, free): X's public embed service. Confirms a post the KOL submitted exists,
//   who wrote it and what it says. No search, no replies, no engagement numbers.
// - "api": the paid X API (about $0.005 per post read). Adds search and the reply bot check.
// - "fixture": a local JSON file, for tests and for trying the agent without network access.

import { readFileSync } from "node:fs";

const API = "https://api.x.com/2";
const OEMBED = "https://publish.twitter.com/oembed";

/** X post ids encode their creation time: (id >> 22) + Twitter epoch, in milliseconds. */
export function postTimeMs(id) {
  return Number((BigInt(id) >> 22n) + 1288834974657n);
}

/** Pulls author handle and post text out of an oEmbed response. */
export function parseOembed(body) {
  const handle = String(body.author_url || "").split("/").filter(Boolean).pop() || null;
  const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(body.html || "");
  const text = (p ? p[1] : "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .trim();
  return { handle, text };
}

export function makeX({ mode, bearer, fixturePath }) {
  if (mode === "fixture") return fixtureX(fixturePath);
  if (mode === "api") {
    if (!bearer) throw new Error("X_MODE=api needs X_BEARER_TOKEN");
    return apiX(bearer);
  }
  return oembedX();
}

function oembedX() {
  // The handle in the URL is only a hint; the response's author_url says who really wrote it.
  async function lookup(id, handle = "i") {
    const url = `${OEMBED}?${new URLSearchParams({ url: `https://twitter.com/${handle}/status/${id}`, omit_script: "true", dnt: "true" })}`;
    const res = await fetch(url, { headers: { "User-Agent": "kol-escrow-agent" } });
    if (res.status === 404 || res.status === 403) return null; // deleted, protected or never existed
    if (!res.ok) throw new Error(`X embed service ${res.status}`);
    return parseOembed(await res.json());
  }
  return {
    supportsSearch: false,
    supportsReplies: false,
    async findPost({ handle, claimedId }) {
      if (!claimedId) return null; // free mode can't search: the KOL submits their link
      const p = await lookup(claimedId, handle);
      if (!p) return null;
      return { id: claimedId, text: p.text, createdAtNs: BigInt(postTimeMs(claimedId)) * 1_000_000n, authorHandle: p.handle };
    },
    async isLive(postId, handle) {
      return (await lookup(postId, handle)) !== null;
    },
    async replies() {
      return [];
    },
  };
}

function apiX(bearer) {
  async function get(path, params) {
    const url = `${API}${path}?${new URLSearchParams(params)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`X API ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    return body;
  }
  const one = (body) => {
    const users = new Map((body.includes?.users || []).map((u) => [u.id, u.username]));
    const t = Array.isArray(body.data) ? body.data[0] : body.data;
    if (!t) return null;
    return { id: t.id, text: t.text, createdAtNs: BigInt(Date.parse(t.created_at)) * 1_000_000n, authorHandle: users.get(t.author_id) || null };
  };
  const fields = { "tweet.fields": "created_at,author_id", expansions: "author_id", "user.fields": "username" };

  return {
    supportsSearch: true,
    supportsReplies: true,
    /** The KOL's submitted post if there is one, otherwise their newest post with the required text. */
    async findPost({ handle, requiredText, sinceIso, claimedId }) {
      if (claimedId) return one(await get("/tweets", { ids: claimedId, ...fields }));
      const params = { query: `from:${handle} ${quote(requiredText)} -is:retweet`, max_results: "10", ...fields };
      if (sinceIso) params.start_time = sinceIso;
      return one(await get("/tweets/search/recent", params));
    },
    async isLive(postId) {
      const body = await get("/tweets", { ids: postId, "tweet.fields": "created_at" });
      return Array.isArray(body.data) && body.data.some((t) => t.id === postId);
    },
    /** Up to `max` replies to the post, with each author's account age and follower count. */
    async replies(postId, max = 30) {
      const body = await get("/tweets/search/recent", {
        query: `conversation_id:${postId} is:reply`,
        max_results: String(Math.max(10, Math.min(100, max))),
        "tweet.fields": "author_id,text",
        expansions: "author_id",
        "user.fields": "created_at,public_metrics",
      });
      const users = new Map((body.includes?.users || []).map((u) => [u.id, u]));
      return (body.data || []).slice(0, max).map((t) => {
        const u = users.get(t.author_id) || {};
        return { text: t.text, authorCreatedAtMs: u.created_at ? Date.parse(u.created_at) : null, authorFollowers: u.public_metrics?.followers_count ?? null };
      });
    },
  };
}

function fixtureX(path) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  const shape = (p) => ({ id: p.id, text: p.text, createdAtNs: BigInt(Date.parse(p.created_at)) * 1_000_000n, authorHandle: p.handle });
  return {
    supportsSearch: true,
    supportsReplies: true,
    async findPost({ handle, requiredText, claimedId }) {
      const posts = (data.posts || []).filter((p) => !p.deleted);
      const p = claimedId
        ? posts.find((p) => p.id === claimedId)
        : posts.find((p) => p.handle.toLowerCase() === handle.toLowerCase() && p.text.toLowerCase().includes(requiredText.toLowerCase()));
      return p ? shape(p) : null;
    },
    async isLive(postId) {
      const p = (data.posts || []).find((p) => p.id === postId);
      return Boolean(p && !p.deleted);
    },
    async replies(postId) {
      return ((data.replies || {})[postId] || []).map((r) => ({ text: r.text, authorCreatedAtMs: Date.parse(r.author_created_at), authorFollowers: r.author_followers }));
    },
  };
}

function quote(s) {
  const clean = String(s).replace(/"/g, "");
  return /\s/.test(clean) ? `"${clean}"` : clean;
}
