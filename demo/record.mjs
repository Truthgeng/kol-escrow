// Records the live website for the demo video: 1920x1080 video of a page, slow scroll, optional
// clicks. Usage: node demo/record.mjs <name> <path> [actions]
// actions: comma list of "wait:ms", "scroll:px", "open-records", "top", "into:<css>",
//   "pick:<css>=<option text>", "type:<css>=<text>", "click:<css>"   (a full URL works as the path too)
import { chromium } from "playwright";
import { mkdirSync, readdirSync, renameSync } from "node:fs";

const [name, path, actions = "wait:3000,scroll:500,wait:2000,open-records,wait:3000"] = process.argv.slice(2);
const out = "demo/out";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5, colorScheme: "dark",
  recordVideo: { dir: `${out}/tmp-${name}`, size: { width: 1280, height: 720 } },
});
const page = await ctx.newPage();
await page.goto(path.startsWith("http") ? path : `https://kol-escrow.vercel.app/${path}`, { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(1500);
const smooth = async (dy) => page.evaluate((dy) => new Promise((r) => { const s = window.scrollY, t0 = performance.now(); const f = (t) => { const p = Math.min(1, (t - t0) / 1200); window.scrollTo(0, s + dy * (1 - Math.pow(1 - p, 3))); p < 1 ? requestAnimationFrame(f) : r(); }; requestAnimationFrame(f); }), dy);
for (const a of actions.split(",")) {
  const i = a.indexOf(":");
  const k = i < 0 ? a : a.slice(0, i), v = i < 0 ? "" : a.slice(i + 1);
  const [sel, arg] = v.split("=");
  if (k === "wait") await page.waitForTimeout(Number(v));
  else if (k === "scroll") await smooth(Number(v));
  else if (k === "top") await smooth(-(await page.evaluate(() => window.scrollY)));
  else if (k === "open-records") {
    for (const d of await page.$$("details")) { await d.evaluate((el) => (el.open = true)); await page.waitForTimeout(700); }
  }
  else if (k === "shot") await page.screenshot({ path: `${out}/${name}-${v}.png` });
  else if (k === "into") await page.locator(sel).first().evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
  else if (k === "pick") { const el = page.locator(sel).first(); await el.waitFor({ timeout: 20000 }); const val = await el.locator("option", { hasText: arg }).first().getAttribute("value"); await el.selectOption(val); }
  else if (k === "type") await page.locator(sel).first().pressSequentially(arg, { delay: 45 });
  else if (k === "click") await page.locator(sel).first().click();
}
await page.screenshot({ path: `${out}/${name}.png` });
await ctx.close();
await browser.close();
const dir = `${out}/tmp-${name}`;
renameSync(`${dir}/${readdirSync(dir)[0]}`, `${out}/${name}.webm`);
console.log(`recorded ${out}/${name}.webm`);
