// Small proxy to the NEAR Intents 1Click API, so the browser avoids cross-site blocks and an
// API key (ONECLICK_API_KEY, optional, removes the 0.2% fee) never reaches the client.

const BASE = "https://1click.chaindefuser.com/v0";

export async function oneclick(path, init = {}) {
  const headers = { "Content-Type": "application/json", ...(init.headers || {}) };
  if (process.env.ONECLICK_API_KEY) headers["X-API-Key"] = process.env.ONECLICK_API_KEY;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { message: text.slice(0, 300) }; }
  return { status: res.status, body };
}

export function send(res, status, body, cacheSecs = 0) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", cacheSecs ? `public, s-maxage=${cacheSecs}` : "no-store");
  res.status(status).send(JSON.stringify(body));
}
