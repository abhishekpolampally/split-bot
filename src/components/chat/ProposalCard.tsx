"use client";

import { AlertTriangle, Check, CornerUpLeft } from "lucide-react";
import { useState } from "react";
import { Avatar, BotAvatar, Button, cx } from "@/components/ui";
import { api } from "@/lib/client";
import { track } from "@/lib/firebase/analytics";
import { initials } from "@/lib/colors";
import { formatINR } from "@/lib/money";
import { describeRule } from "@/lib/split/engine";
import type { SplitSpec } from "@/lib/split/types";
import type { MessageView, ProposalView } from "@/lib/types";
import { useChat } from "./context";

export function ProposalCard({ msg, p }: { msg: MessageView; p: ProposalView }) {
  const chat = useChat();
  const [busy, setBusy] = useState<"confirm" | "cancel" | "chip" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const spec = p.spec;
  const res = p.result;
  const open = p.status === "proposed";
  const payer = chat.member(spec.payerId);
  const isPayer = spec.payerId === chat.meId;
  const isSender = p.senderMemberId === chat.meId;
  const canConfirm = isPayer || (Boolean(payer?.isPlaceholder) && isSender);
  const canManage = isPayer || isSender;
  const items = spec.rule === "itemwise" ? (spec.items ?? []) : [];
  const charges = spec.charges ?? [];
  const chargeTotal = res.lines.reduce((s, l) => s + l.chargesPaise, 0);
  const memberOrder = chat.members.map((m) => m.id);
  const chipMembers = chat.members.filter((m) => spec.participants.includes(m.id) || items.some((i) => i.participants.includes(m.id)));

  async function act(action: "confirm" | "cancel") {
    setBusy(action);
    setError(null);
    try {
      await api(`/api/groups/${chat.groupId}/proposals/${p.id}`, { body: { action } });
      if (action === "confirm") track("expense_confirm", { rule: spec.rule, members: res.lines.length });
      chat.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function toggle(itemIdx: number, memberId: string) {
    if (!open || busy) return;
    if (!canManage && memberId !== chat.meId) return;
    const item = items[itemIdx];
    const has = item.participants.includes(memberId);
    if (has && item.participants.length === 1) return;
    const next = has
      ? item.participants.filter((x) => x !== memberId)
      : memberOrder.filter((x) => x === memberId || item.participants.includes(x));
    const newSpec: SplitSpec = { ...spec, items: items.map((it, i) => (i === itemIdx ? { ...it, participants: next } : it)) };
    setBusy("chip");
    setError(null);
    try {
      await api(`/api/groups/${chat.groupId}/proposals/${p.id}`, { method: "PATCH", body: { spec: newSpec, version: p.version } });
      chat.refresh();
    } catch (e) {
      setError((e as Error).message);
      chat.refresh();
    } finally {
      setBusy(null);
    }
  }

  const label =
    p.status === "superseded" ? "SplitBot · replaced" : p.editsExpenseId ? "SplitBot · proposed edit" : "SplitBot · proposed split";
  const intro = (msg.data as { intro?: string } | null)?.intro;

  return (
    <div className="flex items-start gap-2">
      <BotAvatar />
      <div className={cx("w-[318px] max-w-[calc(100%-36px)] overflow-hidden rounded-2xl border border-card-edge bg-white", p.status === "superseded" && "opacity-60", p.status === "cancelled" && "opacity-70")}>
        <div className="flex flex-col gap-0.5 bg-tint px-3.5 pb-2.5 pt-3">
          <div className="flex items-center justify-between">
            <div className="text-xs font-bold text-brand">{label}</div>
            {open && (
              <button className="flex items-center gap-1 text-xs font-bold text-muted" onClick={() => chat.replyTo(msg.id, "@splitbot ")} aria-label="Reply to correct this split">
                <CornerUpLeft size={13} /> Reply
              </button>
            )}
          </div>
          {intro && <div className="text-xs text-muted">{intro}</div>}
          <div className="flex items-baseline justify-between gap-2">
            <span className={cx("text-lg font-extrabold", p.status === "cancelled" && "line-through")}>{spec.description}</span>
            <span className="text-xl font-extrabold">{formatINR(res.totalPaise)}</span>
          </div>
          <div className="text-[13px] text-muted">
            Paid by {chat.display(spec.payerId).replace(/^You$/, "you")} ·{" "}
            {items.length ? `${items.length} item${items.length === 1 ? "" : "s"}` : describeRule(spec)}
          </div>
        </div>

        {p.flags.includes("amount") && open && (
          <div className="mx-3.5 mt-2.5 flex items-center gap-1.5 rounded-lg bg-owe-bg px-2.5 py-1.5 text-xs font-semibold text-owe-ink">
            <AlertTriangle size={14} /> I&apos;m not fully sure about the amounts. Please double-check.
          </div>
        )}

        {items.length > 0 && (
          <>
            <div className="flex items-baseline justify-between px-3.5 pb-1 pt-2.5">
              <span className="text-[13px] font-bold">Who had what</span>
              <span className="text-xs text-muted">{open ? (canManage ? "Tap initials to change" : "Tap yours to claim") : "Locked"}</span>
            </div>
            <div className="px-3.5">
              {items.map((it, idx) => (
                <div key={idx} className="flex items-center gap-2 border-b border-line py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-bold">{it.qty > 1 ? `${it.name} ×${it.qty}` : it.name}</div>
                    <div className="text-xs text-muted">
                      {formatINR(it.amountPaise)} · {it.participants.length} {it.participants.length === 1 ? "person" : "people"}
                    </div>
                  </div>
                  <div className="flex flex-wrap justify-end gap-1">
                    {chipMembers.map((m) => {
                      const on = it.participants.includes(m.id);
                      const locked = !open || (!canManage && m.id !== chat.meId);
                      return (
                        <button
                          key={m.id}
                          onClick={() => toggle(idx, m.id)}
                          aria-label={`${m.name} had ${it.name}: ${on ? "yes" : "no"}`}
                          aria-pressed={on}
                          disabled={locked}
                          className="flex h-9 w-9 items-center justify-center rounded-full border-[1.5px] p-0 text-[13px] font-extrabold"
                          style={{ borderColor: on ? m.color : "#C5CCD3", background: on ? m.color : "#fff", color: on ? "#fff" : "#6B7771" }}
                        >
                          {initials(m.name)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              {charges.length > 0 && (
                <div className="flex justify-between py-2 text-xs text-muted">
                  <span>{charges.map((c) => `${c.label} ${formatINR(c.amountPaise)}`).join(" + ")}, split by share</span>
                  <span>{formatINR(chargeTotal)}</span>
                </div>
              )}
            </div>
          </>
        )}

        <div className={cx("px-3.5 pb-1 pt-2 text-[13px] font-bold", items.length > 0 && "border-t border-line-2")}>Each person pays</div>
        <div className="px-3.5 pb-1.5">
          {[...res.lines]
            .sort((a, b) => memberOrder.indexOf(a.memberId) - memberOrder.indexOf(b.memberId))
            .map((l) => {
              const m = chat.member(l.memberId);
              const detail =
                items.length > 0
                  ? `items ${formatINR(l.itemsPaise)}${l.chargesPaise ? ` + tax & service ${formatINR(l.chargesPaise)}` : ""}`
                  : l.adjustPaise
                    ? `share ${formatINR(l.itemsPaise + l.chargesPaise)} + ${formatINR(l.adjustPaise)} extra`
                    : spec.rule === "percent" && spec.percents?.[l.memberId] != null
                      ? `${Math.round(spec.percents[l.memberId] * 100) / 100}%`
                      : spec.rule === "shares"
                        ? `${spec.shares?.[l.memberId] ?? 1} share${(spec.shares?.[l.memberId] ?? 1) === 1 ? "" : "s"}`
                        : null;
              return (
                <div key={l.memberId} className="flex items-center gap-2.5 py-1.5">
                  <Avatar name={m?.name ?? "?"} color={m?.color ?? "#999"} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-bold">
                      {chat.display(l.memberId)}
                      {l.memberId === spec.payerId ? " (paid)" : ""}
                    </div>
                    {detail && <div className="text-[11.5px] text-muted">{detail}</div>}
                  </div>
                  <span className="text-[15px] font-extrabold">{formatINR(l.totalPaise)}</span>
                </div>
              );
            })}
        </div>
        <div className="mx-3.5 flex items-center gap-1.5 rounded-[10px] bg-tint px-2.5 py-2 text-xs font-semibold text-brand-deep">
          <Check size={14} strokeWidth={2.6} /> Shares add up to the total, {formatINR(res.totalPaise)}
        </div>

        {error && <div className="mx-3.5 mt-2 rounded-lg bg-owe-bg px-2.5 py-1.5 text-xs font-semibold text-owe-ink">{error}</div>}

        {open ? (
          <div className="flex flex-col gap-2 px-3.5 pb-3.5 pt-3">
            {!canConfirm && (
              <div className="text-xs text-muted">
                Waiting for {payer?.name ?? "the payer"} to confirm, since they paid.
              </div>
            )}
            <div className="flex gap-2">
              {canManage && (
                <Button variant="ghost" className="flex-1" onClick={() => act("cancel")} loading={busy === "cancel"} disabled={!!busy}>
                  Cancel
                </Button>
              )}
              {canManage && (
                <Button variant="ghost" className="flex-1" onClick={() => chat.openEdit(p.id)} disabled={!!busy}>
                  Edit
                </Button>
              )}
              <Button className="flex-[2]" onClick={() => act("confirm")} loading={busy === "confirm"} disabled={!canConfirm || !!busy}>
                {canConfirm ? (canManage ? "Confirm" : "Confirm split") : `Needs ${payer?.name ?? "payer"}`}
              </Button>
            </div>
          </div>
        ) : (
          <div className={cx("flex items-center gap-1.5 px-3.5 pb-3.5 pt-3 text-[13px] font-bold", p.status === "confirmed" ? "text-brand" : "text-muted")}>
            {p.status === "confirmed" && (
              <>
                <Check size={16} strokeWidth={2.6} /> Confirmed by {chat.display(p.decidedByMemberId).replace(/^You$/, "you")} · added to the ledger
              </>
            )}
            {p.status === "cancelled" && <>Cancelled. Nothing was added.</>}
            {p.status === "superseded" && <>Replaced by an updated split below.</>}
          </div>
        )}
      </div>
    </div>
  );
}
