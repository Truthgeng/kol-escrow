import "./style.css";
import {
  CONFIG, isTestToken, view, initWallet, onAccount, currentAccount, signIn, signOut, send, tx,
  tokenInfo, fromUnits, toUnits, nsToMs, msToNs, intents,
} from "./near.js";

const app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const acctLink = (id) => `<a href="${CONFIG.explorer}/address/${encodeURIComponent(id)}" target="_blank" rel="noopener">${esc(id)}</a>`;
let grace = 600;

// ---------- header ----------

function renderHeader() {
  const el = document.getElementById("account");
  onAccount((id) => {
    el.innerHTML = id
      ? `<span class="who">${esc(id)}</span><button class="link" id="out">Disconnect</button>`
      : `<button class="btn small" id="in">Connect wallet</button>`;
    el.querySelector("#in")?.addEventListener("click", () => signIn().catch(toastError));
    el.querySelector("#out")?.addEventListener("click", () => signOut());
  });
}

// ---------- deal ticket ----------

const STEPS = ["Locked", "Posted", "Holding", "Settled"];

function dealView(d, c, now) {
  const holdMs = Number(c.hold_secs) * 1000;
  const postedMs = d.posted_at ? nsToMs(d.posted_at) : null;
  const deadlineMs = nsToMs(c.deadline);
  const holdEnd = postedMs ? postedMs + holdMs : null;
  let step = 0, label = "", tone = "locked", progress = null, action = null;

  if (d.state === "Pending") {
    step = 0; tone = "locked";
    label = now < deadlineMs ? `Waiting for the post. Deadline ${when(deadlineMs)}` : "Deadline passed with no verified post";
    if (now > deadlineMs + grace * 1000) action = { text: "Refund the project", tx: tx.refundExpired(d.id) };
  } else if (d.state === "Posted") {
    step = now < holdEnd ? 2 : 2; tone = "holding";
    progress = Math.min(1, (now - postedMs) / holdMs);
    label = now < holdEnd ? `Post verified. Must stay up until ${when(holdEnd)}` : "Hold window ended. Waiting for the final check";
    if (now > holdEnd + grace * 1000) action = { text: "Pay the KOL", tx: tx.releaseTimeout(d.id) };
  } else if (d.state === "Released") {
    step = 3; tone = "paid"; label = "Paid to the KOL";
  } else if (d.state === "Refunded") {
    step = 3; tone = "refunded"; label = "Refunded to the project";
  } else {
    step = 3; tone = "holding"; label = "Payment in progress";
  }
  return { step, label, tone, progress, action };
}

function when(ms) {
  const d = new Date(ms);
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function attestation(a) {
  if (!a) return "Triggered by the timeout rule, no agent involved";
  if (a === "rules:v1") return "Checked by the agent's rule check";
  const [, chat, addr, sig] = a.split(":");
  if (addr === "unsigned" || addr === "mismatch" || !sig) return `Checked by NEAR AI (chat ${esc(chat)}), no TEE signature attached`;
  return `Checked by NEAR AI. Signature from its TEE key <code title="${esc(sig)}">${esc(addr.slice(0, 10))}…</code> for chat <code>${esc(chat.slice(0, 14))}</code>`;
}

const VERDICT = {
  post_verified: "Post verified",
  released: "Paid",
  refunded: "Refunded",
  released_timeout: "Paid by timeout",
  refunded_timeout: "Refunded by timeout",
};

function ticket(d, c, token, now) {
  const v = dealView(d, c, now);
  const steps = STEPS.map((s, i) => {
    const name = i === 3 ? (d.state === "Refunded" ? "Refunded" : d.state === "Released" ? "Paid" : "Settled") : s;
    return `<li class="${i < v.step ? "done" : i === v.step ? "now" : ""}">${name}</li>`;
  }).join("");
  const post = d.post_id
    ? `<a href="https://x.com/${esc(d.kol_handle)}/status/${esc(d.post_id)}" target="_blank" rel="noopener">View post</a>`
    : "";
  const verdicts = d.verdicts.map((x) => `
    <li><b>${esc(VERDICT[x.action] || x.action)}</b> <span class="muted">${when(nsToMs(x.at))}</span>
      <p>${esc(x.reason)}</p><p class="att">${attestation(x.attestation)}</p></li>`).join("");
  return `
  <article class="ticket ${v.tone}">
    <header>
      <div><h3>@${esc(d.kol_handle)}</h3><p class="muted">${acctLink(d.kol_account)}</p></div>
      <p class="amount">${fromUnits(d.fee.toString(), token.decimals)} <span>${esc(token.symbol)}</span></p>
    </header>
    <ol class="rail">${steps}</ol>
    ${v.progress != null ? `<div class="bar" role="progressbar" aria-valuenow="${Math.round(v.progress * 100)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${v.progress * 100}%"></span></div>` : ""}
    <p class="status">${esc(v.label)} ${post}</p>
    ${v.action ? `<button class="btn outline" data-tx='${esc(JSON.stringify(v.action.tx))}'>${esc(v.action.text)}</button>` : ""}
    ${verdicts ? `<details><summary>Agent record (${d.verdicts.length})</summary><ul class="verdicts">${verdicts}</ul></details>` : ""}
  </article>`;
}

function wireTxButtons(root, after) {
  root.querySelectorAll("[data-tx]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!currentAccount()) return signIn().catch(toastError);
      b.disabled = true;
      try {
        await send([JSON.parse(b.dataset.tx)]);
        toast("Sent. Updating…");
        after();
      } catch (e) {
        toastError(e);
        b.disabled = false;
      }
    }));
}

// ---------- pages ----------

async function home() {
  app.innerHTML = `
  <section class="hero">
    <div class="hero-copy">
      <h1 class="build">${"KOLs get paid when the post stays up.".split(" ").map((w, i) => `<span style="--i:${i}">${w}</span>`).join(" ")}</h1>
      <p class="lede">The project locks each fee on NEAR. An agent checks the post on X and watches it through the hold window. Delete it early and the project gets refunded. Keep it up and the KOL gets paid.</p>
      <div class="actions"><a class="btn" href="#/new">Start a campaign</a><a class="btn ghost" href="#/me">See my deals</a></div>
    </div>
    <div class="stage" aria-hidden="true">${heroTicket()}</div>
  </section>

  <section class="stats" id="stats" aria-label="Totals on ${esc(CONFIG.network)}">
    <div><b data-count="locked">0</b><span>locked right now</span></div>
    <div><b data-count="paid">0</b><span>paid to KOLs</span></div>
    <div><b data-count="refunded">0</b><span>refunded to projects</span></div>
    <div><b data-count="deals">0</b><span>deals</span></div>
  </section>

  <section class="flow">
    <h2>Where the money can go</h2>
    ${flowSvg()}
    <ul class="flow-notes">
      <li><b>The agent</b> can only confirm a post, pay the KOL's registered account, or refund the project. Its key can't call anything else.</li>
      <li><b>The project</b> can't pull back a locked fee. It can only withdraw money it never gave to a KOL.</li>
      <li><b>Anyone</b> can settle a stuck deal: refund the project if no post was verified by the deadline, or pay the KOL if the agent goes quiet after the hold window.</li>
    </ul>
  </section>

  <section><h2>Latest deal</h2><div id="demo" class="loading">Loading from ${esc(CONFIG.network)}…</div></section>
  <section><h2>Campaigns</h2><div id="list" class="loading">Loading…</div></section>`;

  startHeroLoop();

  const campaigns = await view(CONFIG.escrow, "list_campaigns", { from: 0, limit: 50 });
  const list = document.getElementById("list");
  list.classList.remove("loading");
  list.innerHTML = campaigns.length
    ? `<ul class="campaigns">${[...campaigns].reverse().map((c) => `
        <li><a href="#/c/${c.id}"><b>${esc(c.title)}</b><span class="muted">${c.deal_ids.length} KOL${c.deal_ids.length === 1 ? "" : "s"}, needs ${esc(c.required_text)}</span></a></li>`).join("")}</ul>`
    : `<p>No campaigns yet. <a href="#/new">Start the first one</a>.</p>`;

  const all = await Promise.all(campaigns.map(async (c) => ({ c, deals: await view(CONFIG.escrow, "get_campaign_deals", { campaign_id: c.id }) })));
  const token = await tokenInfo(CONFIG.token);
  const sum = (f) => all.flatMap((x) => x.deals).filter(f).reduce((s, d) => s + BigInt(d.fee), 0n);
  const totals = {
    locked: sum((d) => ["Pending", "Posted", "Settling"].includes(d.state)),
    paid: sum((d) => d.state === "Released"),
    refunded: sum((d) => d.state === "Refunded"),
  };
  const unit = 10n ** BigInt(token.decimals);
  countUp("locked", Number(totals.locked / unit), ` ${token.symbol}`);
  countUp("paid", Number(totals.paid / unit), ` ${token.symbol}`);
  countUp("refunded", Number(totals.refunded / unit), ` ${token.symbol}`);
  countUp("deals", all.reduce((n, x) => n + x.deals.length, 0), "");

  const demo = document.getElementById("demo");
  demo.classList.remove("loading");
  const latest = [...all].reverse().find((x) => x.deals.length);
  if (!latest) return (demo.innerHTML = `<p class="muted">Nothing here yet.</p>`);
  const rank = { Posted: 0, Released: 1, Refunded: 2, Settling: 3, Pending: 4 };
  const pick = [...latest.deals].sort((a, b) => rank[a.state] - rank[b.state])[0];
  demo.innerHTML = `<p class="muted"><a href="#/c/${latest.c.id}">${esc(latest.c.title)}</a></p>` + ticket(pick, latest.c, await tokenInfo(latest.c.token), Date.now());
  wireTxButtons(demo, home);
}

function countUp(key, target, suffix) {
  const el = document.querySelector(`[data-count="${key}"]`);
  if (!el) return;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const t0 = performance.now(), dur = reduce ? 0 : 1400;
  const step = (t) => {
    const p = dur ? Math.min(1, (t - t0) / dur) : 1;
    const v = Math.round(target * (1 - Math.pow(1 - p, 3)));
    el.textContent = v.toLocaleString("en-US") + suffix;
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// The hero ticket plays one deal from start to finish, on a loop.
function heroTicket() {
  return `
  <div class="glass-ticket" data-stage="0">
    <div class="coin"><span>$</span></div>
    <header><div><h3>@cryptodera</h3><p>Mainnet launch push</p></div><p class="amt">150<span>USDC</span></p></header>
    <ol class="rail"><li>Locked</li><li>Posted</li><li>Holding</li><li class="end">Paid</li></ol>
    <div class="bar"><span></span></div>
    <p class="line" data-line="0">Fee locked in escrow</p>
    <p class="line" data-line="1">Post found with #MainnetLaunch</p>
    <p class="line" data-line="2">Still live, day 4 of 7</p>
    <p class="line" data-line="3">Paid to cryptodera.near</p>
  </div>`;
}

let heroTimer;
function startHeroLoop() {
  clearInterval(heroTimer);
  const t = document.querySelector(".glass-ticket");
  if (!t) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return t.setAttribute("data-stage", "3");
  let s = 0;
  heroTimer = setInterval(() => {
    if (!document.body.contains(t)) return clearInterval(heroTimer);
    s = (s + 1) % 5;
    t.setAttribute("data-stage", String(s === 4 ? 3 : s));
    if (s === 4) setTimeout(() => t.setAttribute("data-stage", "reset"), 1400);
  }, 2200);
}

function flowSvg() {
  const label = "The project funds the escrow. The escrow pays the KOL if the post stays up, or refunds the project if it doesn't.";
  const defs = (id) => `<defs><marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>`;
  const vault = (cx, cy) => `<circle cx="${cx}" cy="${cy}" r="14"/><path d="M${cx} ${cy - 14}v-6M${cx} ${cy + 14}v6M${cx - 14} ${cy}h-6M${cx + 14} ${cy}h6"/>`;
  return `
  <svg class="flow-svg wide" viewBox="0 0 720 240" role="img" aria-label="${label}">
    ${defs("ah")}
    <g class="node"><rect x="10" y="62" width="160" height="70" rx="14"/><text x="90" y="94">Project</text><text class="sub" x="90" y="115">locks the fee</text></g>
    <g class="node vault"><rect x="280" y="35" width="160" height="124" rx="18"/>${vault(360, 72)}<text x="360" y="120">Escrow</text><text class="sub" x="360" y="141">on NEAR</text></g>
    <g class="node kol"><rect x="550" y="62" width="160" height="70" rx="14"/><text x="630" y="94">KOL</text><text class="sub" x="630" y="115">any chain via Intents</text></g>
    <path class="wire in" d="M170 97H274" marker-end="url(#ah)"/>
    <path class="wire pay" d="M440 97H544" marker-end="url(#ah)"/>
    <path class="wire back" d="M360 159V210H90V138" marker-end="url(#ah)"/>
    <text class="tag" x="222" y="86">fund</text>
    <text class="tag pay" x="492" y="86">post stayed up</text>
    <text class="tag back" x="225" y="230">deleted, late or botted</text>
  </svg>
  <svg class="flow-svg tall" viewBox="0 0 340 430" role="img" aria-label="${label}">
    ${defs("ah2")}
    <g class="node"><rect x="40" y="10" width="200" height="70" rx="14"/><text x="140" y="42">Project</text><text class="sub" x="140" y="63">locks the fee</text></g>
    <g class="node vault"><rect x="40" y="150" width="200" height="120" rx="18"/>${vault(140, 188)}<text x="140" y="234">Escrow</text><text class="sub" x="140" y="255">on NEAR</text></g>
    <g class="node kol"><rect x="40" y="340" width="200" height="70" rx="14"/><text x="140" y="372">KOL</text><text class="sub" x="140" y="393">any chain via Intents</text></g>
    <path class="wire in" d="M140 80V144" marker-end="url(#ah2)"/>
    <path class="wire pay" d="M140 270V334" marker-end="url(#ah2)"/>
    <path class="wire back" d="M240 210H300V45H246" marker-end="url(#ah2)"/>
    <text class="tag left" x="150" y="117">fund</text>
    <text class="tag pay left" x="150" y="307">post stayed up</text>
    <text class="tag back" x="300" y="128" transform="rotate(90 300 128)" dy="-8">deleted, late or botted</text>
  </svg>`;
}

async function campaignPage(id) {
  app.innerHTML = `<p class="loading">Loading campaign…</p>`;
  const c = await view(CONFIG.escrow, "get_campaign", { campaign_id: Number(id) });
  if (!c) return (app.innerHTML = `<p>No campaign ${esc(id)}. <a href="#/">Back to campaigns</a></p>`);
  const [deals, token] = await Promise.all([view(CONFIG.escrow, "get_campaign_deals", { campaign_id: c.id }), tokenInfo(c.token)]);
  const now = Date.now();
  const locked = deals.filter((d) => ["Pending", "Posted", "Settling"].includes(d.state)).reduce((s, d) => s + BigInt(d.fee), 0n);
  const isProject = currentAccount() === c.project;
  app.innerHTML = `
  <section class="campaign-head">
    <p><a href="#/">All campaigns</a></p>
    <h1>${esc(c.title)}</h1>
    <dl class="facts">
      <div><dt>Post must include</dt><dd>${esc(c.required_text)}</dd></div>
      <div><dt>Deadline</dt><dd>${when(nsToMs(c.deadline))}</dd></div>
      <div><dt>Hold window</dt><dd>${duration(Number(c.hold_secs))}</dd></div>
      <div><dt>Locked now</dt><dd>${fromUnits(locked.toString(), token.decimals)} ${esc(token.symbol)}</dd></div>
      <div><dt>Project</dt><dd>${acctLink(c.project)}</dd></div>
    </dl>
    ${isProject && BigInt(c.unallocated) > 0n ? `<p>${fromUnits(c.unallocated, token.decimals)} ${esc(token.symbol)} not assigned to a KOL. <button class="link" data-tx='${esc(JSON.stringify(tx.withdraw(c.id)))}'>Withdraw it</button></p>` : ""}
  </section>
  <section class="tickets">${deals.map((d) => ticket(d, c, token, now)).join("") || "<p>No KOLs added yet.</p>"}</section>`;
  wireTxButtons(app, () => campaignPage(id));
}

async function mePage() {
  const me = currentAccount();
  if (!me) {
    app.innerHTML = `<section><h1>My deals</h1><p>Connect the wallet the project registered for you to see your locked payments.</p><button class="btn" id="c">Connect wallet</button></section>`;
    return document.getElementById("c").addEventListener("click", () => signIn().catch(toastError));
  }
  app.innerHTML = `<p class="loading">Loading your deals…</p>`;
  const deals = await view(CONFIG.escrow, "get_kol_deals", { kol_account: me });
  const camps = new Map();
  for (const d of deals) if (!camps.has(d.campaign_id)) camps.set(d.campaign_id, await view(CONFIG.escrow, "get_campaign", { campaign_id: d.campaign_id }));
  const now = Date.now();
  const parts = [];
  for (const d of deals.reverse()) {
    const c = camps.get(d.campaign_id);
    const tk = await tokenInfo(c.token);
    parts.push(`<p class="muted"><a href="#/c/${c.id}">${esc(c.title)}</a>, post must include ${esc(c.required_text)}</p>` + ticket(d, c, tk, now) +
      (d.state === "Released" ? payoutPanel(d, c, tk) : ""));
  }
  app.innerHTML = `<section><h1>My deals</h1><p class="muted">${esc(me)}</p></section>
    <section class="tickets">${parts.join("") || "<p>No deals for this account yet. Share your NEAR account with the project so they can lock your fee.</p>"}</section>`;
  wireTxButtons(app, mePage);
  wirePayouts(app);
}

// ---------- cash out on another chain (NEAR Intents 1Click) ----------

const CHAINS = { eth: "Ethereum", base: "Base", arb: "Arbitrum", op: "Optimism", pol: "Polygon", bsc: "BNB Chain", avax: "Avalanche", sol: "Solana", tron: "Tron", ton: "TON", sui: "Sui", aptos: "Aptos", gnosis: "Gnosis", bera: "Berachain", stellar: "Stellar", monad: "Monad", xlayer: "X Layer", scroll: "Scroll", hypercore: "Hyperliquid", miden: "Miden" };
const chainName = (b) => CHAINS[b] || String(b).toUpperCase();
const EVM = new Set(["eth", "base", "arb", "op", "pol", "bsc", "avax", "gnosis", "bera", "monad", "xlayer", "scroll", "hypercore"]);
function addressOk(chain, a) {
  if (EVM.has(chain)) return /^0x[0-9a-fA-F]{40}$/.test(a);
  if (chain === "sol") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
  return a.length >= 10 && a.length <= 120 && !/\s/.test(a);
}

function payoutPanel(d, c, tk) {
  return `
  <div class="payout" data-amount="${esc(d.fee)}" data-token="${esc(c.token)}" data-decimals="${tk.decimals}">
    <h3>Cash out on another chain</h3>
    <p class="muted">Your ${fromUnits(d.fee, tk.decimals)} ${esc(tk.symbol)} is in your NEAR account. Swap and send it to another chain in one step with NEAR Intents.</p>
    <div class="payout-row">
      <label>Receive<select name="dest"><option value="">Loading routes…</option></select></label>
      <label>Your address on that chain<input name="addr" autocomplete="off" spellcheck="false" placeholder="0x… or wallet address"></label>
    </div>
    <div class="payout-actions"><button class="btn outline" data-act="quote" type="button">Get a quote</button><button class="btn" data-act="send" type="button" hidden>Send it</button></div>
    <p class="quote" aria-live="polite"></p>
  </div>`;
}

function wirePayouts(root) {
  const panels = root.querySelectorAll(".payout");
  if (!panels.length) return;
  intents.tokens().then((tokens) => {
    const nearUsdc = tokens.find((t) => t.blockchain === "near" && t.symbol === "USDC");
    const dests = tokens.filter((t) => t.blockchain !== "near").sort((a, b) => chainName(a.blockchain).localeCompare(chainName(b.blockchain)) || a.symbol.localeCompare(b.symbol));
    panels.forEach((p) => {
      p.querySelector('[name="dest"]').innerHTML = `<option value="">Choose a token and chain</option>` +
        dests.map((t) => `<option value="${esc(t.assetId)}" data-chain="${esc(t.blockchain)}" data-dec="${t.decimals}" data-sym="${esc(t.symbol)}">${esc(t.symbol)} on ${esc(chainName(t.blockchain))}</option>`).join("");
      wirePayout(p, nearUsdc);
    });
  }).catch((e) => panels.forEach((p) => (p.querySelector(".quote").textContent = e.message)));
}

function wirePayout(p, nearUsdc) {
  const out = p.querySelector(".quote");
  const sendBtn = p.querySelector('[data-act="send"]');
  const live = CONFIG.network === "mainnet";
  // On mainnet the payout token itself goes into 1Click. On testnet, tUSDC isn't supported, so
  // the quote is a preview priced with real USDC on NEAR and sending is switched off.
  const origin = live ? `nep141:${p.dataset.token}` : nearUsdc?.assetId;
  const read = () => {
    const sel = p.querySelector('[name="dest"]');
    const opt = sel.selectedOptions[0];
    return { dest: sel.value, chain: opt?.dataset.chain, dec: Number(opt?.dataset.dec), sym: opt?.dataset.sym, addr: p.querySelector('[name="addr"]').value.trim() };
  };
  // Refunds go back to the KOL's own account. A testnet account doesn't exist on mainnet, so the
  // testnet preview (a dry quote that moves nothing) uses a placeholder mainnet account instead.
  const params = (v, dry) => ({ dry, originAsset: origin, destinationAsset: v.dest, amount: p.dataset.amount, refundTo: live ? currentAccount() : "intents.near", recipient: v.addr });
  const check = (v) => {
    if (!origin) throw new Error("NEAR Intents doesn't list this token as a source");
    if (!v.dest) throw new Error("Choose where you want to receive it");
    if (!addressOk(v.chain, v.addr)) throw new Error(`That doesn't look like a ${chainName(v.chain)} address`);
  };
  p.querySelector('[data-act="quote"]').addEventListener("click", async () => {
    const v = read();
    try {
      check(v);
      out.textContent = "Asking NEAR Intents for a price…";
      const q = (await intents.quote(params(v, true))).quote;
      out.innerHTML = `You'd receive about <b>${esc(q.amountOutFormatted)} ${esc(v.sym)}</b> on ${esc(chainName(v.chain))}, at least ${esc(fromUnits(q.minAmountOut, v.dec))} after slippage. Usually arrives in about ${Math.max(1, Math.round(q.timeEstimate / 60))} min.` +
        (live ? "" : `<br><span class="muted">Testnet preview: priced with real USDC on NEAR mainnet. Sending works once the escrow runs on mainnet.</span>`);
      sendBtn.hidden = !live;
    } catch (e) {
      out.textContent = e.message;
      sendBtn.hidden = true;
    }
  });
  sendBtn.addEventListener("click", async () => {
    const v = read();
    try {
      check(v);
      sendBtn.disabled = true;
      out.textContent = "Locking in the quote…";
      const q = (await intents.quote(params(v, false))).quote;
      if (!q.depositAddress) throw new Error("NEAR Intents didn't return a deposit address. Try again.");
      out.textContent = "Confirm the transfer in your wallet…";
      await send([tx.payout(p.dataset.token, q.depositAddress, p.dataset.amount, q.depositMemo)]);
      out.textContent = "Sent. Waiting for NEAR Intents to deliver…";
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const s = await intents.status(q.depositAddress, q.depositMemo);
        const words = { PENDING_DEPOSIT: "Waiting to see your deposit…", KNOWN_DEPOSIT_TX: "Deposit seen…", PROCESSING: "Swapping and sending…", SUCCESS: `Delivered to your ${chainName(v.chain)} address.`, REFUNDED: "The route failed and your tokens were refunded to your NEAR account.", FAILED: "The route failed. Check your NEAR account; a refund follows automatically.", INCOMPLETE_DEPOSIT: "The deposit was short. A refund follows automatically." };
        out.textContent = words[s.status] || `Status: ${s.status}`;
        if (["SUCCESS", "REFUNDED", "FAILED"].includes(s.status)) break;
      }
    } catch (e) {
      toastError(e);
      out.textContent = "";
    } finally {
      sendBtn.disabled = false;
    }
  });
}

function duration(s) {
  if (s % 86400 === 0) return `${s / 86400} day${s === 86400 ? "" : "s"}`;
  if (s % 3600 === 0) return `${s / 3600} hour${s === 3600 ? "" : "s"}`;
  return `${Math.round(s / 60)} min`;
}

// ---------- new campaign ----------

function newPage() {
  const defDeadline = new Date(Date.now() + 3 * 86400_000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  app.innerHTML = `
  <section>
    <h1>Start a campaign</h1>
    <p class="lede">You lock each KOL's fee now. It goes to them only if their post goes up by the deadline and stays up for the hold window.</p>
  </section>
  <form id="f" class="form">
    <label>Campaign name<input name="title" required maxlength="120" placeholder="Mainnet launch push"></label>
    <label>The post must include<input name="req" required maxlength="120" placeholder="#YourLaunch or @yourproject"><small>The agent looks for this exact text in the KOL's post.</small></label>
    <div class="row">
      <label>Deadline to post<input type="datetime-local" name="deadline" required value="${defDeadline}"></label>
      <label>Post must stay up for<span class="pair"><input type="number" name="hold" min="1" value="7" required><select name="unit"><option value="86400">days</option><option value="3600">hours</option><option value="60">minutes</option></select></span></label>
    </div>
    <fieldset>
      <legend>KOLs</legend>
      <div id="kols"></div>
      <button type="button" class="link" id="add">Add another KOL</button>
    </fieldset>
    <p class="total" id="total"></p>
    ${isTestToken ? `<p class="note">Testnet uses free tUSDC. You'll get the amount you need minted to your wallet in the same step.</p>` : ""}
    <button class="btn" type="submit" id="go">Lock the fees</button>
    <p class="muted" id="progress" aria-live="polite"></p>
  </form>`;

  const kols = document.getElementById("kols");
  const addRow = () => {
    const row = document.createElement("div");
    row.className = "kol";
    row.innerHTML = `
      <label>X handle<input name="h" required placeholder="@handle" maxlength="16"></label>
      <label>Their NEAR account<input name="a" required placeholder="name.${CONFIG.network === "testnet" ? "testnet" : "near"}"></label>
      <label>Fee<input name="fee" required inputmode="decimal" placeholder="100"></label>
      <button type="button" class="link remove" aria-label="Remove this KOL">Remove</button>`;
    row.querySelector(".remove").addEventListener("click", () => { if (kols.children.length > 1) row.remove(); updateTotal(); });
    row.addEventListener("input", updateTotal);
    kols.append(row);
  };
  const updateTotal = async () => {
    const { decimals, symbol } = await tokenInfo(CONFIG.token);
    let sum = 0n;
    for (const i of kols.querySelectorAll('[name="fee"]')) { try { sum += BigInt(toUnits(i.value || "0", decimals)); } catch {} }
    document.getElementById("total").textContent = `Total to lock: ${fromUnits(sum.toString(), decimals)} ${symbol}`;
  };
  document.getElementById("add").addEventListener("click", addRow);
  addRow();
  updateTotal();

  document.getElementById("f").addEventListener("submit", async (e) => {
    e.preventDefault();
    const me = currentAccount();
    if (!me) return signIn().catch(toastError);
    const f = new FormData(e.target);
    const progress = document.getElementById("progress");
    const go = document.getElementById("go");
    try {
      const { decimals } = await tokenInfo(CONFIG.token);
      const rows = [...kols.children].map((r) => ({
        handle: r.querySelector('[name="h"]').value.trim().replace(/^@/, ""),
        account: r.querySelector('[name="a"]').value.trim().toLowerCase(),
        fee: toUnits(r.querySelector('[name="fee"]').value, decimals),
      }));
      for (const r of rows) {
        if (!/^\w{1,15}$/.test(r.handle)) throw new Error(`"${r.handle}" isn't a valid X handle`);
        if (!/^[a-z0-9._-]{2,64}$/.test(r.account)) throw new Error(`"${r.account}" isn't a valid NEAR account`);
        if (BigInt(r.fee) <= 0n) throw new Error("Every fee must be above zero");
      }
      const total = rows.reduce((s, r) => s + BigInt(r.fee), 0n).toString();
      const deadlineMs = new Date(f.get("deadline")).getTime();
      if (!(deadlineMs > Date.now())) throw new Error("The deadline has to be in the future");
      const holdSecs = Number(f.get("hold")) * Number(f.get("unit"));
      go.disabled = true;

      progress.textContent = "Step 1 of 2: creating the campaign…";
      const first = [];
      if (isTestToken) first.push(tx.mint(me, total));
      first.push(tx.createCampaign({ token: CONFIG.token, title: f.get("title"), required_text: f.get("req"), deadline: msToNs(deadlineMs), hold_secs: String(holdSecs) }));
      const out = await send(first);
      const campaignId = out.at(-1);
      if (campaignId == null) throw new Error("The campaign was created but its number didn't come back. Check your wallet history.");

      progress.textContent = "Step 2 of 2: locking the fees…";
      await send([tx.fund(campaignId, total), ...rows.map((r) => tx.addDeal(campaignId, r.handle, r.account, r.fee))]);
      location.hash = `#/c/${campaignId}`;
    } catch (err) {
      toastError(err);
      progress.textContent = "";
      go.disabled = false;
    }
  });
}

// ---------- toast + router ----------

function toast(msg, bad = false) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = bad ? "show bad" : "show";
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = ""), 6000);
}
function toastError(e) {
  console.error(e);
  const m = String(e?.message || e).replace(/^Error: /, "");
  toast(m.includes("User rejected") || m.includes("closed") ? "Cancelled in the wallet" : m.slice(0, 240), true);
}

async function route() {
  const [, page, id] = location.hash.split("/");
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === `#/${page || ""}`));
  try {
    if (page === "c") await campaignPage(id);
    else if (page === "new") newPage();
    else if (page === "me") await mePage();
    else await home();
  } catch (e) {
    app.innerHTML = `<p>Couldn't load this from ${esc(CONFIG.network)}: ${esc(e.message)}. <a href="#/">Try again</a></p>`;
  }
  window.scrollTo(0, 0);
}

renderHeader();
document.getElementById("net").textContent = CONFIG.network;
view(CONFIG.escrow, "get_config").then((c) => (grace = Number(c[2]))).catch(() => {});
initWallet().finally(() => {
  onAccount(() => { if (location.hash.startsWith("#/me")) route(); });
});
window.addEventListener("hashchange", route);
route();
