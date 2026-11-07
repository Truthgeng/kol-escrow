import { oneclick, send } from "./_oneclick.js";

export default async function handler(req, res) {
  const { depositAddress, depositMemo } = req.query;
  if (!/^[\w.:-]{3,120}$/.test(depositAddress || "")) return send(res, 400, { error: "Missing deposit address" });
  const qs = new URLSearchParams({ depositAddress });
  if (depositMemo) qs.set("depositMemo", depositMemo);
  const { status, body } = await oneclick(`/status?${qs}`);
  if (status < 200 || status > 299) return send(res, status, { error: body?.message || "Status not available yet" });
  send(res, 200, { status: body.status, updatedAt: body.updatedAt, swapDetails: body.swapDetails });
}
