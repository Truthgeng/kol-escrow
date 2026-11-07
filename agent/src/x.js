// Reads posts from X. Two sources:
// - "api": the real X API (pay per use, about $0.005 per post read)
// - "fixture": a local JSON file, for tests and for judges who want to try it without an X key

import { readFileSync } from "node:fs";

const BASE = "https://api.x.com/2";

export function makeX({ mode, bearer, fixturePath }) {
  if (mode === "fixture") return fixtureX(fixturePath);
  if (!bearer) throw new Error("X_BEARER_TOKEN is missing. Set X_MODE=fixture to run without it.");
  return apiX(bearer);
}

function apiX(bearer) {
  async function get(path, params) {
    const url = `${BASE}${path}?${new URLSearchParams(params)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`X API ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    return body;
  }

  return {
    /** Newest post by this handle that contains the required text, since `sinceIso`. */
    async findPost(handle, requiredText, sinceIso) {
      const q = `from:${handle} ${quote(requiredText)} -is:retweet`;
      const params = {
        query: q,
        max_results: "10",
        "tweet.fields": "created_at,author_id",
        expansions: "author_id",
        "user.fields": "username",
      };
      if (sinceIso) params.start_time = sinceIso;
      const body = await get("/tweets/search/recent", params);
      const users = new Map((body.includes?.users || []).map((u) => [u.id, u.username]));
      const t = body.data?.[0];
      if (!t) return null;
      return {
        id: t.id,
        text: t.text,
        createdAtNs: BigInt(Date.parse(t.created_at)) * 1_000_000n,
        authorHandle: users.get(t.author_id) || null,
      };
    },

    /** Is the post still up? A deleted post comes back with no data and a not-found error. */
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
        return {
          text: t.text,
          authorCreatedAtMs: u.created_at ? Date.parse(u.created_at) : null,
          authorFollowers: u.public_metrics?.followers_count ?? null,
        };
      });
    },
  };
}

function fixtureX(path) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  return {
    async findPost(handle, requiredText) {
      const p = (data.posts || []).find(
        (p) => p.handle.toLowerCase() === handle.toLowerCase() &&
          p.text.toLowerCase().includes(requiredText.toLowerCase()) && !p.deleted
      );
      if (!p) return null;
      return {
        id: p.id,
        text: p.text,
        createdAtNs: BigInt(Date.parse(p.created_at)) * 1_000_000n,
        authorHandle: p.handle,
      };
    },
    async isLive(postId) {
      const p = (data.posts || []).find((p) => p.id === postId);
      return Boolean(p && !p.deleted);
    },
    async replies(postId) {
      return ((data.replies || {})[postId] || []).map((r) => ({
        text: r.text,
        authorCreatedAtMs: Date.parse(r.author_created_at),
        authorFollowers: r.author_followers,
      }));
    },
  };
}

function quote(s) {
  const clean = String(s).replace(/"/g, "");
  return /\s/.test(clean) ? `"${clean}"` : clean;
}
