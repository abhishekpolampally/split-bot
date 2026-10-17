"use client";

import Link from "next/link";
import { BottomNav, Loading } from "@/components/ui";
import { timeLabel, useApi } from "@/lib/client";
import { formatINR } from "@/lib/money";

interface Item {
  type: "expense" | "settlement";
  id: string;
  groupId: string;
  groupName: string;
  title: string;
  payer: string;
  totalPaise: number;
  deltaPaise: number;
  at: string;
}

export default function Activity() {
  const { data } = useApi<{ items: Item[] }>("/api/activity", 10000);
  return (
    <>
      <div className="shrink-0 bg-head px-4 pb-4 pt-[max(24px,env(safe-area-inset-top))] text-white">
        <h1 className="text-2xl font-extrabold tracking-tight">Activity</h1>
      </div>
      <div className="no-scrollbar flex-1 overflow-y-auto bg-surface p-4">
        {!data && <Loading />}
        {data && data.items.length === 0 && <p className="py-12 text-center text-sm text-muted">Nothing yet. Confirmed splits and payments show up here.</p>}
        {data && data.items.length > 0 && (
          <div className="rounded-2xl border border-line-2 bg-white px-3.5 py-1">
            {data.items.map((e) => (
              <Link key={e.type + e.id} href={`/g/${e.groupId}/balances`} className="flex gap-3 border-b border-line py-3 last:border-0">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-bold">{e.title}</div>
                  <div className="truncate text-xs text-muted">
                    {e.groupName} · {e.type === "expense" ? `paid by ${e.payer}` : "settlement"} · {timeLabel(e.at)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[15px] font-extrabold">{formatINR(e.totalPaise)}</div>
                  <div className={"text-xs font-semibold " + (e.type === "settlement" ? "text-brand" : e.deltaPaise >= 0 ? "text-brand" : "text-owe")}>
                    {e.type === "settlement"
                      ? "settlement"
                      : e.deltaPaise > 0
                        ? `you lent ${formatINR(e.deltaPaise)}`
                        : e.deltaPaise < 0
                          ? `you borrowed ${formatINR(e.deltaPaise)}`
                          : "not involved"}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
      <BottomNav />
    </>
  );
}
