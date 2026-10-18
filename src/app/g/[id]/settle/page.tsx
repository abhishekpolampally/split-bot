"use client";

import { useParams } from "next/navigation";
import { ArrowRight, CircleCheck } from "lucide-react";
import { useState } from "react";
import { Avatar, Button, Header, Loading } from "@/components/ui";
import { track } from "@/lib/firebase/analytics";
import { api } from "@/lib/client";
import { formatINR, upiLink } from "@/lib/money";
import type { Transfer } from "@/lib/types";
import { useBalances } from "@/lib/useBalances";

export default function Settle() {
  const { id } = useParams<{ id: string }>();
  const { data, name, member, reload } = useBalances(id);
  const [upiFor, setUpiFor] = useState<string | null>(null);
  const [reminded, setReminded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!data) return <Loading />;
  const key = (t: Transfer) => `${t.from}>${t.to}`;
  const n = data.transfers.length;

  async function record(t: Transfer, method: "upi" | "cash") {
    setBusy(key(t) + method);
    setError(null);
    try {
      await api(`/api/groups/${id}/settlements`, { body: { fromMemberId: t.from, toMemberId: t.to, amountPaise: t.amountPaise, method } });
      track("settle_record", { method });
      setUpiFor(null);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function remind(t: Transfer) {
    setBusy(key(t) + "remind");
    try {
      await api(`/api/groups/${id}/remind`, { body: { memberId: t.from } });
      track("reminder_send", {});
      setReminded({ ...reminded, [key(t)]: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function payUpi(t: Transfer) {
    const to = member(t.to);
    setUpiFor(key(t));
    if (to?.upiId) {
      window.location.assign(upiLink({ upiId: to.upiId, name: to.name, amountPaise: t.amountPaise, note: `SplitBot · ${data!.group.name}` }));
    }
  }

  return (
    <>
      <Header title="Settle up" subtitle={data.group.name} back={`/g/${id}/balances`} />
      <div className="no-scrollbar flex flex-1 flex-col gap-3 overflow-y-auto bg-surface p-4">
        {n > 0 && (
          <div className="text-[15px] leading-relaxed">
            {n === 1 ? "1 payment clears" : `${n} payments clear`} every balance in {data.group.name}.
          </div>
        )}
        {error && <div className="rounded-xl bg-owe-bg px-3 py-2 text-[13px] font-semibold text-owe-ink">{error}</div>}

        {data.transfers.map((t) => {
          const from = member(t.from);
          const to = member(t.to);
          const k = key(t);
          const iPay = t.from === data.meId;
          const iGet = t.to === data.meId;
          const proxy = !iPay && !iGet && (from?.isPlaceholder || to?.isPlaceholder);
          const sentence = iGet ? `${name(t.from)} pays you` : iPay ? `You pay ${name(t.to)}` : `${name(t.from)} pays ${name(t.to)}`;
          return (
            <div key={k} className="flex flex-col gap-3 rounded-2xl border border-line-2 bg-white p-3.5">
              <div className="flex items-center gap-2">
                <Avatar name={from?.name ?? "?"} color={from?.color ?? "#999"} size={36} />
                <ArrowRight size={22} className="text-[#7D8A84]" />
                <Avatar name={to?.name ?? "?"} color={to?.color ?? "#999"} size={36} />
                <span className="flex-1 pl-1 text-sm">{sentence}</span>
                <span className="text-[17px] font-extrabold">{formatINR(t.amountPaise)}</span>
              </div>

              {iPay && upiFor !== k && (
                <Button onClick={() => payUpi(t)}>
                  {to?.upiId ? `Pay ${formatINR(t.amountPaise)} via UPI` : `Pay ${name(t.to)} ${formatINR(t.amountPaise)}`}
                </Button>
              )}
              {iPay && upiFor === k && (
                <div className="flex flex-col gap-2.5 rounded-xl bg-tint p-3">
                  <div className="text-[13px] leading-relaxed text-brand-deep">
                    {to?.upiId ? (
                      <>
                        Your UPI app opens with {formatINR(t.amountPaise)} to {to.name} ({to.upiId}) and the note “SplitBot · {data.group.name}”
                        filled in. Come back here once it goes through.
                      </>
                    ) : (
                      <>{to?.name} hasn&apos;t added a UPI ID yet. Pay them however you like, then mark it here.</>
                    )}
                  </div>
                  <Button variant="outline" onClick={() => record(t, "upi")} loading={busy === k + "upi"}>
                    I&apos;ve paid {to?.name}
                  </Button>
                  <button className="text-[13px] font-bold text-muted" onClick={() => record(t, "cash")}>
                    Paid in cash instead
                  </button>
                </div>
              )}
              {iGet && (
                <div className="flex gap-2">
                  <Button
                    variant={reminded[k] ? "ghost" : "outline"}
                    className="flex-1"
                    onClick={() => remind(t)}
                    disabled={reminded[k]}
                    loading={busy === k + "remind"}
                  >
                    {reminded[k] ? "Reminder sent in chat" : `Remind ${from?.name}`}
                  </Button>
                  <Button variant="ghost" className="flex-1" onClick={() => record(t, "cash")} loading={busy === k + "cash"}>
                    Mark received
                  </Button>
                </div>
              )}
              {proxy && (
                <Button variant="ghost" onClick={() => record(t, "cash")} loading={busy === k + "cash"}>
                  Mark as paid
                </Button>
              )}
            </div>
          );
        })}

        {n === 0 && (
          <div className="flex flex-col items-center gap-1.5 rounded-2xl border border-line-2 bg-white p-6 text-center">
            <CircleCheck size={36} className="text-brand" strokeWidth={2.2} />
            <div className="text-base font-extrabold">Everyone&apos;s settled up</div>
            <div className="text-[13px] text-muted">No payments left in {data.group.name}.</div>
          </div>
        )}
        <div className="text-xs leading-relaxed text-muted">
          Payments are simplified so the group makes the fewest transfers. SplitBot never holds money; UPI payments go straight between
          members.
        </div>
      </div>
    </>
  );
}
