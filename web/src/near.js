// Chain access for the web app: plain JSON-RPC for reads, NEAR Connect for signing.
// On testnet there is also a built-in test wallet: a fresh .testnet account made in one tap,
// with its key kept in this browser only, so anyone can try the full flow without a wallet app.

import { NearConnector } from "@hot-labs/near-connect";

export const CONFIG = {
  network: import.meta.env.VITE_NETWORK || "testnet",
  escrow: import.meta.env.VITE_ESCROW || "kolescrow4-1c4994.testnet",
  token: import.meta.env.VITE_TOKEN || "koltusdc-1c4994.testnet",
  rpc: import.meta.env.VITE_RPC || "https://test.rpc.fastnear.com",
  explorer: import.meta.env.VITE_EXPLORER || "https://testnet.nearblocks.io",
};
export const isTestToken = CONFIG.network === "testnet";

const TGAS = "000000000000";
// Storage deposits; the contract refunds whatever isn't used.
const STORAGE = { campaign: "10000000000000000000000", deal: "25000000000000000000000", apply: "10000000000000000000000" };

export async function view(contractId, method, args = {}) {
  const res = await fetch(CONFIG.rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "kol",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contractId,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    }),
  });
  const body = await res.json();
  if (body.error || body.result?.error) throw new Error(body.error?.data || body.result?.error || "RPC error");
  return JSON.parse(new TextDecoder().decode(new Uint8Array(body.result.result)));
}

// ---------- wallet ----------

let connector;
let accountId = null;
let mode = null; // "connector" or "guest"
const GUEST_KEY = "kolescrow.guest.v1";
const listeners = new Set();

export function onAccount(fn) {
  listeners.add(fn);
  fn(accountId);
  return () => listeners.delete(fn);
}
function setAccount(id) {
  accountId = id;
  listeners.forEach((fn) => fn(id));
}
export const currentAccount = () => accountId;

export const hasGuestWallet = CONFIG.network === "testnet";
export const currentMode = () => mode;

export async function initWallet() {
  connector = new NearConnector({ network: CONFIG.network, footerBranding: null });
  connector.on("wallet:signIn", (t) => {
    mode = "connector";
    setAccount(t.accounts?.[0]?.accountId || null);
  });
  connector.on("wallet:signOut", () => {
    if (mode === "connector") setAccount(null);
  });
  const guest = hasGuestWallet && loadGuest();
  if (guest) {
    mode = "guest";
    return setAccount(guest.accountId);
  }
  try {
    const { accounts } = await connector.getConnectedWallet();
    if (accounts?.[0]?.accountId) {
      mode = "connector";
      setAccount(accounts[0].accountId);
    }
  } catch {}
}

/** Opens the NEAR wallet picker (Meteor, Intear, HOT on mainnet, and others). */
export async function connectWallet() {
  await connector.connect();
}

export async function signOut() {
  if (mode === "guest") {
    // The key stays saved, so "Use the test wallet" brings back the same account and its deals.
    sessionStorageSet("kolescrow.guest.off", "1");
  } else {
    await connector.disconnect().catch(() => {});
  }
  mode = null;
  setAccount(null);
}

// ---------- built-in test wallet (testnet only) ----------

function loadGuest() {
  try {
    if (sessionStorage.getItem("kolescrow.guest.off")) return null;
  } catch {}
  return savedGuest();
}
function savedGuest() {
  try {
    const g = JSON.parse(localStorage.getItem(GUEST_KEY) || "null");
    return g && /^kolguest-[a-z0-9]{10}\.testnet$/.test(g.accountId) && g.secret ? g : null;
  } catch {
    return null;
  }
}
function sessionStorageSet(k, v) {
  try {
    v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v);
  } catch {}
}

/** Signs in with the browser's test wallet, creating a funded .testnet account the first time. */
export async function useGuestWallet(onStep = () => {}) {
  if (!hasGuestWallet) throw new Error("The test wallet only works on testnet");
  sessionStorageSet("kolescrow.guest.off", null);
  let g = savedGuest();
  if (!g) {
    const { KeyPair } = await import("near-api-js");
    const kp = KeyPair.fromRandom("ed25519");
    const rand = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
    const id = `kolguest-${rand}.testnet`;
    onStep("Creating your test account on NEAR testnet…");
    const r = await fetch("/api/faucet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: id, publicKey: kp.getPublicKey().toString() }),
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.error || "Couldn't create a test account. Try again in a minute.");
    onStep("Waiting for the account to appear on chain…");
    for (let i = 0; i < 20 && !(await accountExists(id)); i++) await new Promise((res) => setTimeout(res, 1500));
    if (!(await accountExists(id))) throw new Error("The test account didn't show up yet. Try again in a minute.");
    g = { accountId: id, secret: kp.toString() };
    try {
      localStorage.setItem(GUEST_KEY, JSON.stringify(g));
    } catch {
      throw new Error("This browser blocks storage, so the test wallet can't keep its key. Use a NEAR wallet instead.");
    }
  }
  mode = "guest";
  setAccount(g.accountId);
  return g.accountId;
}

async function accountExists(id) {
  const r = await fetch(CONFIG.rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "a", method: "query", params: { request_type: "view_account", finality: "final", account_id: id } }),
  }).then((x) => x.json()).catch(() => ({}));
  return !!r.result;
}

async function guestSend(txs) {
  const g = savedGuest();
  if (!g) throw new Error("Test wallet not found in this browser");
  const { Account, JsonRpcProvider, actions } = await import("near-api-js");
  const acct = new Account(g.accountId, new JsonRpcProvider({ url: CONFIG.rpc }), g.secret);
  const out = [];
  for (const t of txs) {
    const acts = t.actions.map(({ params: p }) => actions.functionCall(p.methodName, p.args, BigInt(p.gas), BigInt(p.deposit)));
    out.push(await acct.signAndSendTransaction({ receiverId: t.receiverId, actions: acts, waitUntil: "FINAL" }));
  }
  return out;
}

function fc(methodName, args, gasT = 100, deposit = "0") {
  return { type: "FunctionCall", params: { methodName, args, gas: gasT + TGAS, deposit } };
}

/** Sends transactions in order and returns each result's decoded return value. */
export async function send(txs) {
  if (mode === "guest") return (await guestSend(txs)).map(returnValue);
  const wallet = await connector.wallet();
  const outcomes = await wallet.signAndSendTransactions({
    transactions: txs.map((t) => ({ receiverId: t.receiverId, actions: t.actions })),
  });
  return outcomes.map(returnValue);
}

function returnValue(o) {
  const s = o?.status;
  if (s && typeof s === "object" && "Failure" in s) throw new Error(JSON.stringify(s.Failure).slice(0, 300));
  const b64 = s?.SuccessValue;
  if (!b64) return null;
  try {
    return JSON.parse(atob(b64));
  } catch {
    return null;
  }
}

// ---------- contract helpers ----------

export const tx = {
  mint: (account, amount) => ({ receiverId: CONFIG.token, actions: [fc("mint", { account_id: account, amount }, 30)] }),
  // Storage is paid by the caller; the contract refunds whatever isn't used.
  createCampaign: (a) => ({ receiverId: CONFIG.escrow, actions: [fc("create_campaign", a, 30, STORAGE.campaign)] }),
  fund: (campaignId, amount, token = CONFIG.token) => ({
    receiverId: token,
    actions: [fc("ft_transfer_call", { receiver_id: CONFIG.escrow, amount, msg: JSON.stringify({ campaign_id: campaignId }) }, 100, "1")],
  }),
  addDeal: (campaignId, kol_handle, kol_account, fee) => ({
    receiverId: CONFIG.escrow,
    actions: [fc("add_deal", { campaign_id: campaignId, kol_handle, kol_account, fee }, 30, STORAGE.deal)],
  }),
  submitPost: (dealId, postId) => ({ receiverId: CONFIG.escrow, actions: [fc("submit_post", { deal_id: dealId, post_id: postId }, 30)] }),
  refundExpired: (dealId) => ({ receiverId: CONFIG.escrow, actions: [fc("refund_expired", { deal_id: dealId })] }),
  releaseTimeout: (dealId) => ({ receiverId: CONFIG.escrow, actions: [fc("release_timeout", { deal_id: dealId })] }),
  // Cash out through NEAR Intents: register the 1Click deposit address on the token (refunded if
  // already registered), then send the tokens to it. 1Click swaps and delivers on the chosen chain.
  payout: (token, depositAddress, amount, memo) => ({
    receiverId: token,
    actions: [
      fc("storage_deposit", { account_id: depositAddress, registration_only: true }, 10, "1250000000000000000000"),
      fc("ft_transfer", memo ? { receiver_id: depositAddress, amount, memo } : { receiver_id: depositAddress, amount }, 30, "1"),
    ],
  }),
  apply: (campaignId, kol_handle, fee, pitch) => ({
    receiverId: CONFIG.escrow,
    actions: [fc("apply", { campaign_id: campaignId, kol_handle, fee, pitch }, 30, STORAGE.apply)],
  }),
  // The fee moves from the campaign's open budget into a deal, so it needs the same storage as add_deal.
  acceptApp: (appId) => ({ receiverId: CONFIG.escrow, actions: [fc("accept_application", { app_id: appId }, 30, STORAGE.deal)] }),
  rejectApp: (appId) => ({ receiverId: CONFIG.escrow, actions: [fc("reject_application", { app_id: appId }, 30)] }),
  withdrawApp: (appId) => ({ receiverId: CONFIG.escrow, actions: [fc("withdraw_application", { app_id: appId }, 30)] }),
  withdraw: (campaignId) => ({ receiverId: CONFIG.escrow, actions: [fc("withdraw_unallocated", { campaign_id: campaignId })] }),
};

// ---------- formatting ----------

let decimalsCache = new Map();
export async function tokenInfo(token) {
  if (!decimalsCache.has(token)) {
    const m = await view(token, "ft_metadata").catch(() => ({ decimals: 6, symbol: "tokens" }));
    decimalsCache.set(token, { decimals: m.decimals, symbol: m.symbol });
  }
  return decimalsCache.get(token);
}
export function fromUnits(raw, decimals) {
  const v = BigInt(raw);
  const d = 10n ** BigInt(decimals);
  const whole = v / d;
  const frac = (v % d).toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 2);
  return frac ? `${whole.toLocaleString("en-US")}.${frac}` : whole.toLocaleString("en-US");
}
export function toUnits(text, decimals) {
  const [w, f = ""] = String(text).trim().split(".");
  if (!/^\d+$/.test(w || "0") || !/^\d*$/.test(f)) throw new Error("Enter a plain number, like 150 or 99.5");
  return (BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0")).toString();
}
// ---------- NEAR Intents (1Click) through the app's own /api routes ----------

export const intents = {
  async tokens() {
    if (!intents._t) intents._t = fetch("/api/tokens").then((r) => (r.ok ? r.json() : Promise.reject(new Error("NEAR Intents token list unavailable"))));
    return intents._t;
  },
  async quote(params) {
    const r = await fetch("/api/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.error || "Couldn't get a quote");
    return b;
  },
  async status(depositAddress, depositMemo) {
    const qs = new URLSearchParams({ depositAddress });
    if (depositMemo) qs.set("depositMemo", depositMemo);
    const r = await fetch(`/api/status?${qs}`);
    return r.ok ? r.json() : { status: "PENDING_DEPOSIT" };
  },
};

export const nsToMs = (ns) => Number(BigInt(ns) / 1_000_000n);
export const msToNs = (ms) => (BigInt(Math.floor(ms)) * 1_000_000n).toString();
