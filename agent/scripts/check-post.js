// Checks one real post with the same free X embed lookup the agent uses.
// Usage: node scripts/check-post.js https://x.com/handle/status/1234567890
import { makeX, postTimeMs } from "../src/x.js";

const url = process.argv[2] || process.env.POST_URL || "";
const m = /(?:x|twitter)\.com\/(\w{1,15})\/status\/(\d{1,20})/i.exec(url);
if (!m) {
  console.error("Give a post link like https://x.com/handle/status/1234567890");
  process.exit(2);
}
const [, handle, id] = m;
const x = makeX({ mode: "oembed" });
const post = await x.findPost({ handle, claimedId: id });
if (!post) {
  console.log(`Not found: post ${id} is deleted, protected, or the link is wrong.`);
  process.exit(1);
}
console.log(`Author:  @${post.authorHandle}${post.authorHandle?.toLowerCase() === handle.toLowerCase() ? "" : `  (link said @${handle})`}`);
console.log(`Posted:  ${new Date(postTimeMs(id)).toISOString()} (read from the post id)`);
console.log(`Text:    ${post.text.replace(/\n/g, " / ")}`);
console.log(`Live:    ${await x.isLive(id, handle) ? "yes" : "no"}`);
