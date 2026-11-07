import "./style.css";
import {
  CONFIG, isTestToken, view, initWallet, onAccount, currentAccount, signIn, signOut, send, tx,
  tokenInfo, fromUnits, toUnits, nsToMs, msToNs,
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
  return `Checked by NEAR AI inside a TEE. Signed by <code title="${esc(sig)}">${esc(addr.slice(0, 10))}…</code> for chat <code>${esc(chat.slice(0, 14))}</code>`;
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
    <h1>KOLs get paid when the post stays up. Projects get refunded when it doesn't.</h1>
    <p class="lede">The project locks each KOL's fee on NEAR. An agent checks the post on X, watches it through the hold window, then pays the KOL or refunds the project. Neither side can pull the money once it's locked.</p>
    <div class="actions"><a class="btn" href="#/new">Start a campaign</a><a class="btn ghost" href="#/me">See my deals</a></div>
  </section>
  <section><h2>Latest deal</h2><div id="demo" class="loading">Loading from ${esc(CONFIG.network)}…</div></section>
  <section class="rules">
    <h2>Who can move the money</h2>
    <ul>
      <li><b>The agent</b> can only confirm a post, pay the KOL's registered account, or refund the project. Its key can't call anything else.</li>
      <li><b>The project</b> can't take back a locked fee. It can only withdraw money it never assigned to a KOL.</li>
      <li><b>Anyone</b> can refund the project if no post was verified by the deadline, or pay the KOL if the agent stays silent after the hold window.</li>
    </ul>
  </section>
  <section><h2>Campaigns</h2><div id="list" class="loading">Loading…</div></section>`;

  const campaigns = await view(CONFIG.escrow, "list_campaigns", { from: 0, limit: 50 });
  const list = document.getElementById("list");
  list.classList.remove("loading");
  list.innerHTML = campaigns.length
    ? `<ul class="campaigns">${[...campaigns].reverse().map((c) => `
        <li><a href="#/c/${c.id}"><b>${esc(c.title)}</b><span class="muted">${c.deal_ids.length} KOL${c.deal_ids.length === 1 ? "" : "s"}, needs ${esc(c.required_text)}</span></a></li>`).join("")}</ul>`
    : `<p>No campaigns yet. <a href="#/new">Start the first one</a>.</p>`;

  const demo = document.getElementById("demo");
  demo.classList.remove("loading");
  const latest = [...campaigns].reverse().find((c) => c.deal_ids.length);
  if (!latest) return (demo.innerHTML = `<p class="muted">Nothing here yet.</p>`);
  const deals = await view(CONFIG.escrow, "get_campaign_deals", { campaign_id: latest.id });
  const token = await tokenInfo(latest.token);
  // Show the deal that says the most: one in its hold window, then a settled one, then any.
  const rank = { Posted: 0, Released: 1, Refunded: 2, Settling: 3, Pending: 4 };
  const pick = [...deals].sort((a, b) => rank[a.state] - rank[b.state])[0];
  demo.innerHTML = `<p class="muted"><a href="#/c/${latest.id}">${esc(latest.title)}</a></p>` + ticket(pick, latest, token, Date.now());
  wireTxButtons(demo, home);
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
    parts.push(`<p class="muted"><a href="#/c/${c.id}">${esc(c.title)}</a>, post must include ${esc(c.required_text)}</p>` + ticket(d, c, await tokenInfo(c.token), now));
  }
  app.innerHTML = `<section><h1>My deals</h1><p class="muted">${esc(me)}</p></section>
    <section class="tickets">${parts.join("") || "<p>No deals for this account yet. Share your NEAR account with the project so they can lock your fee.</p>"}</section>`;
  wireTxButtons(app, mePage);
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
