"use client";

import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Avatar, Button, cx, ErrorNote, Field, inputCls, Sheet } from "@/components/ui";
import { api } from "@/lib/client";
import { initials } from "@/lib/colors";
import { formatINR, parseAmountToPaise } from "@/lib/money";
import { computeSplit } from "@/lib/split/engine";
import { CATEGORIES, type Category, type SplitRule, type SplitSpec } from "@/lib/split/types";
import type { ProposalView } from "@/lib/types";
import { useChat } from "./context";

type Mode = Exclude<SplitRule, "itemwise"> | "itemwise";
const MODES: { id: Mode; label: string }[] = [
  { id: "equal", label: "Equally" },
  { id: "exact", label: "Amounts" },
  { id: "percent", label: "%" },
  { id: "shares", label: "Shares" },
  { id: "itemwise", label: "Items" },
];

const rupees = (paise: number | undefined | null) => (paise ? String(paise / 100) : "");
const toPaise = (s: string) => (s.trim() ? parseAmountToPaise(s) : 0);

interface ItemRow {
  name: string;
  amount: string;
  qty: number;
  participants: string[];
}

export function ExpenseSheet({ open, onClose, proposal }: { open: boolean; onClose: () => void; proposal?: ProposalView | null }) {
  const chat = useChat();
  const all = chat.members.map((m) => m.id);
  const init = proposal?.spec;

  const [description, setDescription] = useState(init?.description ?? "");
  const [category, setCategory] = useState<Category>(init?.category ?? "other");
  const [amount, setAmount] = useState(rupees(init?.totalPaise ?? proposal?.result.totalPaise));
  const [payerId, setPayerId] = useState(init?.payerId ?? chat.meId);
  const [mode, setMode] = useState<Mode>(init?.rule ?? "equal");
  const [participants, setParticipants] = useState<string[]>(init?.participants?.length ? init.participants : all);
  const [values, setValues] = useState<Record<string, string>>(() => {
    if (!init) return {};
    if (init.rule === "exact") return Object.fromEntries(Object.entries(init.exact ?? {}).map(([k, v]) => [k, rupees(v)]));
    if (init.rule === "percent") return Object.fromEntries(Object.entries(init.percents ?? {}).map(([k, v]) => [k, String(v)]));
    if (init.rule === "shares") return Object.fromEntries(Object.entries(init.shares ?? {}).map(([k, v]) => [k, String(v)]));
    return {};
  });
  const [items, setItems] = useState<ItemRow[]>(
    init?.items?.map((i) => ({ name: i.name, amount: rupees(i.amountPaise), qty: i.qty, participants: i.participants })) ?? [
      { name: "", amount: "", qty: 1, participants: all },
    ],
  );
  const [charges, setCharges] = useState(rupees((init?.charges ?? []).reduce((s, c) => s + c.amountPaise, 0)));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const spec = useMemo<SplitSpec | null>(() => {
    const base = { description: description.trim() || "Expense", category, payerId, participants };
    if (mode === "itemwise") {
      const its = items
        .filter((i) => i.name.trim() || i.amount.trim())
        .map((i) => ({ name: i.name.trim() || "Item", qty: i.qty, amountPaise: toPaise(i.amount) ?? 0, participants: i.participants }));
      const ch = toPaise(charges) ?? 0;
      return {
        ...base,
        rule: "itemwise",
        totalPaise: null,
        participants: all,
        items: its,
        charges: ch ? [{ type: "other", label: "Tax & charges", amountPaise: ch }] : [],
      };
    }
    const total = toPaise(amount);
    if (!total) return null;
    const nums = (f: (s: string) => number | null) =>
      Object.fromEntries(participants.filter((m) => values[m]?.trim()).map((m) => [m, f(values[m]) ?? 0]));
    if (mode === "exact") return { ...base, rule: "exact", totalPaise: total, exact: nums(toPaise), remainder: "equal" };
    if (mode === "percent") return { ...base, rule: "percent", totalPaise: total, percents: nums((s) => Number(s) || 0) };
    if (mode === "shares") return { ...base, rule: "shares", totalPaise: total, shares: nums((s) => Number(s) || 0) };
    return { ...base, rule: "equal", totalPaise: total };
  }, [description, category, payerId, participants, mode, items, charges, amount, values, all]);

  const preview = useMemo(() => (spec ? computeSplit(spec) : null), [spec]);

  async function save() {
    if (!spec || !preview?.ok) return;
    setBusy(true);
    setError(null);
    try {
      if (proposal) {
        await api(`/api/groups/${chat.groupId}/proposals/${proposal.id}`, { method: "PATCH", body: { spec, version: proposal.version } });
      } else {
        await api(`/api/groups/${chat.groupId}/proposals`, { body: spec });
      }
      chat.refresh();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const togglePerson = (id: string) =>
    setParticipants((p) => (p.includes(id) ? p.filter((x) => x !== id) : all.filter((x) => x === id || p.includes(x))));

  return (
    <Sheet open={open} onClose={onClose} title={proposal ? "Edit split" : "Add expense"}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <Field label="What for?">
              <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Dinner at Toit" maxLength={80} />
            </Field>
          </div>
          {mode !== "itemwise" && (
            <div className="w-32 shrink-0">
              <Field label="Amount (₹)">
                <input className={inputCls} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="2400" />
              </Field>
            </div>
          )}
        </div>

        <Field label="Category">
          <select className={inputCls} value={category} onChange={(e) => setCategory(e.target.value as Category)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c[0].toUpperCase() + c.slice(1)}
              </option>
            ))}
          </select>
        </Field>

        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-bold">Paid by</span>
          <div className="no-scrollbar flex gap-1.5 overflow-x-auto pb-1">
            {chat.members.map((m) => (
              <button
                type="button"
                key={m.id}
                onClick={() => setPayerId(m.id)}
                className={cx(
                  "flex h-9 shrink-0 items-center gap-1.5 rounded-full border-[1.5px] pl-1 pr-3 text-[13px] font-bold",
                  payerId === m.id ? "border-brand bg-tint text-brand" : "border-edge",
                )}
              >
                <Avatar name={m.name} color={m.color} />
                {chat.display(m.id)}
              </button>
            ))}
          </div>
          {payerId !== chat.meId && !chat.member(payerId)?.isPlaceholder && (
            <span className="text-xs text-muted">{chat.member(payerId)?.name} will need to confirm, since they paid.</span>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-bold">Split</span>
          <div className="grid grid-cols-5 gap-1 rounded-xl bg-surface p-1">
            {MODES.map((m) => (
              <button
                type="button"
                key={m.id}
                onClick={() => setMode(m.id)}
                className={cx("h-9 rounded-lg text-[13px] font-bold", mode === m.id ? "bg-white text-brand shadow-sm" : "text-muted")}
              >
                {m.label}
              </button>
            ))}
          </div>

          {mode !== "itemwise" ? (
            <div className="flex flex-col">
              {chat.members.map((m) => {
                const on = participants.includes(m.id);
                const line = preview?.lines.find((l) => l.memberId === m.id);
                return (
                  <div key={m.id} className="flex items-center gap-2.5 border-b border-line py-2">
                    <button
                      type="button"
                      onClick={() => togglePerson(m.id)}
                      aria-pressed={on}
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-[1.5px] text-[13px] font-extrabold"
                      style={{ borderColor: on ? m.color : "#C5CCD3", background: on ? m.color : "#fff", color: on ? "#fff" : "#6B7771" }}
                    >
                      {initials(m.name)}
                    </button>
                    <span className={cx("flex-1 text-sm font-bold", !on && "text-faint")}>{chat.display(m.id)}</span>
                    {on && mode !== "equal" && (
                      <input
                        className={inputCls + " h-9 w-20 text-right"}
                        inputMode="decimal"
                        placeholder={mode === "exact" ? "auto" : mode === "percent" ? "%" : "1"}
                        value={values[m.id] ?? ""}
                        onChange={(e) => setValues({ ...values, [m.id]: e.target.value })}
                      />
                    )}
                    <span className="w-20 text-right text-sm font-extrabold">{line ? formatINR(line.totalPaise) : "—"}</span>
                  </div>
                );
              })}
              {mode === "exact" && <span className="pt-1.5 text-xs text-muted">Leave blank to split what&apos;s left equally.</span>}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {items.map((it, idx) => (
                <div key={idx} className="flex flex-col gap-1.5 rounded-xl border border-line-2 p-2">
                  <div className="flex gap-2">
                    <input
                      className={inputCls + " h-9 flex-1"}
                      placeholder="Item"
                      value={it.name}
                      onChange={(e) => setItems(items.map((x, j) => (j === idx ? { ...x, name: e.target.value } : x)))}
                    />
                    <input
                      className={inputCls + " h-9 w-24 text-right"}
                      inputMode="decimal"
                      placeholder="₹"
                      value={it.amount}
                      onChange={(e) => setItems(items.map((x, j) => (j === idx ? { ...x, amount: e.target.value } : x)))}
                    />
                    <button type="button" aria-label="Remove item" className="px-1 text-muted" onClick={() => setItems(items.filter((_, j) => j !== idx))}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {chat.members.map((m) => {
                      const on = it.participants.includes(m.id);
                      return (
                        <button
                          type="button"
                          key={m.id}
                          onClick={() =>
                            setItems(
                              items.map((x, j) =>
                                j !== idx
                                  ? x
                                  : { ...x, participants: on ? x.participants.filter((p) => p !== m.id) : all.filter((p) => p === m.id || x.participants.includes(p)) },
                              ),
                            )
                          }
                          className="flex h-8 w-8 items-center justify-center rounded-full border-[1.5px] text-xs font-extrabold"
                          style={{ borderColor: on ? m.color : "#C5CCD3", background: on ? m.color : "#fff", color: on ? "#fff" : "#6B7771" }}
                        >
                          {initials(m.name)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              <button
                type="button"
                className="flex items-center gap-1.5 self-start py-1 text-sm font-bold text-brand"
                onClick={() => setItems([...items, { name: "", amount: "", qty: 1, participants: all }])}
              >
                <Plus size={16} /> Add item
              </button>
              <Field label="Tax, service & tip (₹)" hint="Shared in proportion to each person's items.">
                <input className={inputCls} inputMode="decimal" value={charges} onChange={(e) => setCharges(e.target.value)} placeholder="0" />
              </Field>
              {preview && (
                <div className="flex flex-col rounded-xl bg-surface p-2.5">
                  {preview.lines.map((l) => (
                    <div key={l.memberId} className="flex justify-between text-sm">
                      <span>{chat.display(l.memberId)}</span>
                      <span className="font-extrabold">{formatINR(l.totalPaise)}</span>
                    </div>
                  ))}
                  <div className="mt-1 flex justify-between border-t border-line-2 pt-1 text-sm font-extrabold">
                    <span>Total</span>
                    <span>{formatINR(preview.totalPaise)}</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {preview && !preview.ok && <ErrorNote>{preview.errors[0]}</ErrorNote>}
        <ErrorNote>{error}</ErrorNote>
        <Button type="submit" className="h-12 text-base" loading={busy} disabled={!preview?.ok}>
          {proposal ? "Update split" : "Post to group"}
        </Button>
        {!proposal && <p className="-mt-2 text-center text-xs text-muted">The group sees a card; it hits the ledger once the payer confirms.</p>}
      </form>
    </Sheet>
  );
}
