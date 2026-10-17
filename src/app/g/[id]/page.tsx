"use client";

import { useParams, useRouter } from "next/navigation";
import { Scale } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatContext, type ChatCtx } from "@/components/chat/context";
import { Composer, type ComposerHandle } from "@/components/chat/Composer";
import { ExpenseSheet } from "@/components/chat/ExpenseSheet";
import { MessageItem, Typing } from "@/components/chat/Messages";
import { Avatar, Header, Loading } from "@/components/ui";
import { api, dayLabel } from "@/lib/client";
import type { MemberView, MessageView } from "@/lib/types";

interface GroupInfo {
  group: { id: string; name: string; color: string; inviteToken: string };
  meId: string;
  members: MemberView[];
}
interface Poll {
  messages: MessageView[];
  cursor: { after: number; since: string };
  botBusy: string | null;
  members?: MemberView[];
}

export default function GroupChat() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [info, setInfo] = useState<GroupInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Map<number, MessageView>>(new Map());
  const [botBusy, setBotBusy] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ open: boolean; proposalId?: string }>({ open: false });
  const cursor = useRef({ after: 0, since: "" });
  const polling = useRef(false);
  const tick = useRef(0);
  const composer = useRef<ComposerHandle>(null);

  const poll = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      const withMembers = tick.current++ % 10 === 0;
      const q = new URLSearchParams({ after: String(cursor.current.after) });
      if (cursor.current.since) q.set("since", cursor.current.since);
      if (withMembers) q.set("members", "1");
      const res = await api<Poll>(`/api/groups/${id}/messages?${q}`);
      cursor.current = res.cursor;
      setBotBusy(res.botBusy);
      if (res.members) setInfo((i) => (i ? { ...i, members: res.members! } : i));
      if (res.messages.length) {
        setMsgs((prev) => {
          const next = new Map(prev);
          for (const m of res.messages) next.set(m.id, m);
          return next;
        });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      polling.current = false;
    }
  }, [id]);

  useEffect(() => {
    api<GroupInfo>(`/api/groups/${id}`).then(setInfo, (e) => setError((e as Error).message));
    void poll();
  }, [id, poll]);

  // Poll faster while the bot is working.
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === "visible" && void poll(), botBusy ? 900 : 2500);
    const onVis = () => document.visibilityState === "visible" && void poll();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [poll, botBusy]);

  const list = useMemo(() => [...msgs.values()].sort((a, b) => a.id - b.id), [msgs]);

  const replyTo = useCallback(
    (messageId: number, prefill?: string) => composer.current?.prefill(prefill ?? "", msgs.get(messageId) ?? null),
    [msgs],
  );

  const ctx = useMemo<ChatCtx | null>(() => {
    if (!info) return null;
    const byId = new Map(info.members.map((m) => [m.id, m]));
    return {
      groupId: id,
      groupName: info.group.name,
      meId: info.meId,
      members: info.members,
      member: (mid) => (mid ? byId.get(mid) : undefined),
      display: (mid) => (mid === info.meId ? "You" : ((mid && byId.get(mid)?.name) ?? "Someone")),
      refresh: () => void poll(),
      openEdit: (proposalId) => setSheet({ open: true, proposalId }),
      replyTo,
    };
  }, [info, id, poll, replyTo]);

  async function send(body: string, replyToId: number | null) {
    await api(`/api/groups/${id}/messages`, { body: { body, replyToId } });
    if (/@splitbot\b/i.test(body)) setBotBusy("Reading that…");
    await poll();
  }

  if (error && !info) return <p className="p-8 text-center text-owe">{error}</p>;
  // ctx only reads the composer ref inside event callbacks, never during render.
  // eslint-disable-next-line react-hooks/refs
  if (!info || !ctx) return <Loading />;

  const editing = sheet.proposalId ? list.find((m) => m.proposal?.id === sheet.proposalId)?.proposal : null;
  const subtitle = info.members.map((m) => (m.id === info.meId ? "You" : m.name)).join(", ") + ", SplitBot";

  return (
    <ChatContext.Provider value={ctx}>
      <Header
        title={info.group.name}
        subtitle={subtitle}
        back="/"
        onTitleClick={() => router.push(`/g/${id}/info`)}
        avatar={<Avatar name={info.group.name} color={info.group.color} size={40} />}
        right={
          <button
            onClick={() => router.push(`/g/${id}/balances`)}
            className="flex h-10 items-center gap-1.5 rounded-full bg-head-2 px-3 text-[13px] font-bold"
            aria-label="Group balances"
          >
            <Scale size={18} /> Balances
          </button>
        }
      />

      <div className="no-scrollbar flex flex-1 flex-col-reverse overflow-y-auto bg-chat">
        <div className="flex flex-col gap-2.5 px-3 pb-4 pt-3">
          {list.map((m, i) => {
            const prev = list[i - 1];
            const showDay = !prev || dayLabel(prev.createdAt) !== dayLabel(m.createdAt);
            const replyTarget = m.kind === "text" && m.replyToId ? msgs.get(m.replyToId) : undefined;
            return (
              <div key={m.id} className="contents">
                {showDay && (
                  <div className="self-center rounded-lg bg-surface px-2.5 py-1 text-xs font-semibold text-muted">{dayLabel(m.createdAt)}</div>
                )}
                <MessageItem msg={m} prev={showDay ? undefined : prev} replyTarget={replyTarget} />
              </div>
            );
          })}
          {botBusy && <Typing label={botBusy} />}
        </div>
      </div>

      <Composer ref={composer} onSend={send} onAddExpense={() => setSheet({ open: true })} />
      {sheet.open && (
        <ExpenseSheet
          key={sheet.proposalId ?? "new"}
          open
          proposal={editing}
          onClose={() => setSheet({ open: false })}
        />
      )}
    </ChatContext.Provider>
  );
}
