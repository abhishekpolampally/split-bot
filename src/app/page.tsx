"use client";

import Link from "next/link";
import { Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Avatar, BotAvatar, BottomNav, Loading, Pill } from "@/components/ui";
import { timeLabel, useApi } from "@/lib/client";

interface GroupRow {
  id: string;
  name: string;
  color: string;
  memberCount: number;
  net: number;
  unread: number;
  last: { text: string; at: string } | null;
  createdAt: string;
}

export default function ChatList() {
  const { data, error } = useApi<{ groups: GroupRow[] }>("/api/groups", 5000);
  const [q, setQ] = useState("");
  const groups = useMemo(
    () => (data?.groups ?? []).filter((g) => g.name.toLowerCase().includes(q.toLowerCase())),
    [data, q],
  );

  return (
    <>
      <div className="flex shrink-0 flex-col gap-3.5 bg-head px-4 pb-4 pt-[max(24px,env(safe-area-inset-top))] text-white">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-extrabold tracking-tight">SplitBot</h1>
          <Link href="/new" aria-label="New group" className="flex h-11 w-11 items-center justify-center rounded-full bg-head-2">
            <Plus size={20} strokeWidth={2} />
          </Link>
        </div>
        <label className="flex h-11 items-center gap-2 rounded-xl bg-head-2 px-3">
          <Search size={18} className="text-mint" />
          <span className="sr-only">Search chats</span>
          <input
            placeholder="Search chats"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="flex-1 bg-transparent text-[15px] text-white outline-none placeholder:text-mint"
          />
        </label>
      </div>

      <div className="no-scrollbar flex-1 overflow-y-auto">
        {!data && !error && <Loading />}
        {error && <p className="p-6 text-center text-sm text-owe">{error}</p>}
        {data && data.groups.length === 0 && (
          <div className="flex flex-col items-center gap-4 px-8 py-16 text-center">
            <BotAvatar size={56} />
            <h2 className="text-lg font-extrabold">Start your first group</h2>
            <p className="text-sm leading-relaxed text-muted">
              Create a group for your flat, trip or Friday dinner. Add friends, share the invite link, and tag @splitbot with what you
              paid.
            </p>
            <Link href="/new" className="flex h-12 items-center rounded-xl bg-brand px-6 font-extrabold text-white">
              New group
            </Link>
          </div>
        )}
        {groups.map((g) => (
          <Link
            key={g.id}
            href={`/g/${g.id}`}
            className="flex min-h-[76px] items-center gap-3 border-b border-line bg-white px-4 py-3 active:bg-surface"
          >
            <Avatar name={g.name} color={g.color} size={48} />
            <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <span className="flex justify-between gap-2">
                <span className="truncate text-base font-bold">{g.name}</span>
                <span className={g.unread ? "text-xs font-bold text-brand" : "text-xs text-muted"}>
                  {timeLabel(g.last?.at ?? g.createdAt)}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <span className="flex-1 truncate text-sm text-muted">{g.last?.text ?? `${g.memberCount} members`}</span>
                {g.unread > 0 && (
                  <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1.5 text-[11px] font-bold text-white">
                    {g.unread > 99 ? "99+" : g.unread}
                  </span>
                )}
              </span>
              <span className="mt-[3px]">
                <Pill net={g.net} />
              </span>
            </span>
          </Link>
        ))}
      </div>
      <BottomNav />
    </>
  );
}
