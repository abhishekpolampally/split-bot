"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Avatar, Button, Header, Loading, Sheet } from "@/components/ui";
import { api, timeLabel } from "@/lib/client";
import { formatINR } from "@/lib/money";
import { useBalances, type BalancesData } from "@/lib/useBalances";

type Expense = Extract<BalancesData["activity"][number], { type: "expense" }>;

export default function Balances() {
  const { id } = useParams<{ id: string }>();
  const { data, name, member, reload } = useBalances(id);
  const [open, setOpen] = useState<Expense | null>(null);
  const [busy, setBusy] = useState(false);

  if (!data) return <Loading />;
  const me = data.net[data.meId] ?? 0;
  const owedBy = data.transfers.filter((t) => t.to === data.meId);
  const owing = data.transfers.filter((t) => t.from === data.meId);

  async function del(e: Expense) {
    if (!confirm(`Delete “${e.title}”? This updates everyone's balances.`)) return;
    setBusy(true);
    try {
      await api(`/api/groups/${id}/expenses/${e.id}`, { method: "DELETE" });
      setOpen(null);
      await reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Header title="Balances" subtitle={`${data.group.name} · ${data.members.length} members`} back={`/g/${id}`} />
      <div className="no-scrollbar flex flex-1 flex-col gap-4 overflow-y-auto bg-surface p-4">
        <div className="rounded-2xl border border-line-2 bg-white p-[18px]">
          <div className="text-sm font-semibold text-muted">{me > 0 ? "You are owed" : me < 0 ? "You owe" : "You are all settled"}</div>
          <div className={"text-4xl font-extrabold tracking-tight " + (me > 0 ? "text-brand" : me < 0 ? "text-owe" : "text-muted")}>
            {me === 0 ? "₹0" : formatINR(me)}
          </div>
          <div className="mt-0.5 text-[13px] text-muted">
            {me > 0
              ? `across ${owedBy.length} ${owedBy.length === 1 ? "person" : "people"} in this group`
              : me < 0
                ? `to ${owing.map((t) => name(t.to)).join(", ")}`
                : "Nothing to pay or collect"}
          </div>
          <div className="mt-2 text-xs text-muted">Group spend so far: {formatINR(data.totalSpendPaise)}</div>
        </div>

        <section>
          <h2 className="mb-2 text-sm font-bold">Members</h2>
          <div className="rounded-2xl border border-line-2 bg-white px-3.5 py-1">
            {data.members.map((m) => {
              const n = data.net[m.id] ?? 0;
              return (
                <div key={m.id} className="flex items-center gap-3 border-b border-line py-2.5 last:border-0">
                  <Avatar name={m.name} color={m.color} size={36} />
                  <span className="flex-1 text-[15px] font-bold">
                    {name(m.id)}
                    {m.isPlaceholder && <span className="ml-1.5 text-xs font-semibold text-muted">not joined</span>}
                  </span>
                  <span className="text-right">
                    <span className="block text-xs text-muted">{n > 0 ? "gets back" : n < 0 ? "owes" : "settled"}</span>
                    <span className={"block text-[15px] font-extrabold " + (n > 0 ? "text-brand" : n < 0 ? "text-owe" : "text-muted")}>
                      {n === 0 ? "—" : formatINR(n)}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-bold">Activity</h2>
          <div className="rounded-2xl border border-line-2 bg-white px-3.5 py-1">
            {data.activity.length === 0 && <p className="py-4 text-center text-sm text-muted">No expenses yet.</p>}
            {data.activity.map((e) =>
              e.type === "expense" ? (
                <button key={e.id} onClick={() => setOpen(e)} className="flex w-full gap-3 border-b border-line py-3 text-left last:border-0">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-bold">{e.title}</div>
                    <div className="text-xs text-muted">
                      {timeLabel(e.at)} · paid by {name(e.payerMemberId).replace(/^You$/, "you")}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[15px] font-extrabold">{formatINR(e.totalPaise)}</div>
                    <div className={"text-xs font-semibold " + (e.payerMemberId === data.meId ? "text-brand" : "text-owe")}>
                      {e.payerMemberId === data.meId
                        ? `you lent ${formatINR(e.totalPaise - e.myShare)}`
                        : e.myShare
                          ? `you borrowed ${formatINR(e.myShare)}`
                          : "not involved"}
                    </div>
                  </div>
                </button>
              ) : (
                <div key={e.id} className="flex gap-3 border-b border-line py-3 last:border-0">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-bold">
                      {name(e.from)} paid {name(e.to).replace(/^You$/, "you")}
                    </div>
                    <div className="text-xs text-muted">
                      {e.method === "cash" ? "Cash" : "UPI"} · {timeLabel(e.at)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[15px] font-extrabold">{formatINR(e.amountPaise)}</div>
                    <div className="text-xs font-semibold text-brand">settlement</div>
                  </div>
                </div>
              ),
            )}
          </div>
        </section>
      </div>
      <div className="shrink-0 border-t border-line-2 bg-white px-4 pb-[max(18px,env(safe-area-inset-bottom))] pt-3">
        <Link href={`/g/${id}/settle`} className="flex h-[52px] w-full items-center justify-center rounded-[14px] bg-brand text-base font-extrabold text-white">
          Settle up
        </Link>
      </div>

      <Sheet open={!!open} onClose={() => setOpen(null)} title={open?.title ?? ""}>
        {open && (
          <div className="flex flex-col gap-3">
            <div className="text-sm text-muted">
              {formatINR(open.totalPaise)} · paid by {name(open.payerMemberId)} · {new Date(open.at).toLocaleString("en-IN")}
            </div>
            <div className="rounded-xl bg-surface p-3">
              {Object.entries(open.shares).map(([mid, amt]) => (
                <div key={mid} className="flex items-center gap-2 py-1">
                  <Avatar name={member(mid)?.name ?? "?"} color={member(mid)?.color ?? "#999"} size={24} />
                  <span className="flex-1 text-sm">{name(mid)}</span>
                  <span className="text-sm font-extrabold">{formatINR(amt)}</span>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted">
              To change this expense, reply to its card in the chat with a correction, e.g. “@splitbot make that 2000”.
            </p>
            <Button variant="danger" onClick={() => del(open)} loading={busy}>
              Delete expense
            </Button>
          </div>
        )}
      </Sheet>
    </>
  );
}
