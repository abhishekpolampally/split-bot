"use client";

import { useParams, useRouter } from "next/navigation";
import { Scale } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChatContext, type ChatCtx } from "@/components/chat/context";
import { Composer, type ComposerHandle } from "@/components/chat/Composer";
import { ExpenseSheet } from "@/components/chat/ExpenseSheet";
import { MessageItem, Typing } from "@/components/chat/Messages";
import { Avatar, Header, Loading } from "@/components/ui";
import { track } from "@/lib/firebase/analytics";
import type { GroupInfo } from "@/lib/chatCache";
import { applyPoll, checkUser, dropChat, getChat, hydrateChat, resetChat, setChatInfo, setChatMembers, subscribeChat } from "@/lib/chatStore";
import { api, ApiError, dayLabel } from "@/lib/client";
import type { MemberView, MessageView } from "@/lib/types";

interface Poll {
  userId: string;
  messages: MessageView[];
  cursor: { after: number; since: string };
  /** The catch-up was bigger than one page: start over from the latest page. */
  truncated?: boolean;
  hasMore?: boolean;
  botBusy: string | null;
  members?: MemberView[];
}

const NO_MESSAGES = new Map<number, MessageView>();
// Removed from the group, or the group is gone: its saved copy goes too.
const isGone = (e: unknown) => e instanceof ApiError && (e.status === 403 || e.status === 404);

export default function GroupChat() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  // Messages, info and the poll cursor live in chatStore (memory, backed by IndexedDB), so a chat
  // opened before shows at once and polling picks up where it left off.
  const subscribe = useCallback((fn: () => void) => subscribeChat(id, fn), [id]);
  const chat = useSyncExternalStore(subscribe, () => getChat(id), () => undefined);
  const info = chat?.info ?? null;
  const msgs = chat?.messages ?? NO_MESSAGES;
  const [error, setError] = useState<string | null>(null);
  // Never cached: a stale "Thinking…" would hang around, so it always comes from a poll.
  const [botBusy, setBotBusy] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ open: boolean; proposalId?: string }>({ open: false });
  const polling = useRef(false);
  const tick = useRef(0);
  const composer = useRef<ComposerHandle>(null);

  const poll = useCallback(async () => {
    // Until the saved copy is read, a poll would start from scratch and load everything again.
    if (polling.current || !getChat(id)?.hydrated) return;
    polling.current = true;
    try {
      // A second round only when the first says the copy is too far behind (`truncated`).
      for (let round = 0; round < 2; round++) {
        const { cursor } = getChat(id)!;
        const withMembers = tick.current++ % 10 === 0;
        const q = new URLSearchParams({ after: String(cursor.after) });
        if (cursor.since) q.set("since", cursor.since);
        if (withMembers) q.set("members", "1");
        const res = await api<Poll>(`/api/groups/${id}/messages?${q}`);
        // Someone else's chats on this device: they're deleted and the page starts over.
        if (!(await checkUser(res.userId))) return;
        setBotBusy(res.botBusy);
        if (res.truncated) {
          // Away too long to catch up message by message: drop the copy and load the latest page.
          await resetChat(id);
          continue;
        }
        applyPoll(id, res.messages, res.cursor, res.hasMore);
        if (res.members) setChatMembers(id, res.members);
        break;
      }
    } catch (e) {
      if (isGone(e)) dropChat(id);
      setError((e as Error).message);
    } finally {
      polling.current = false;
    }
  }, [id]);

  useEffect(() => {
    let live = true;
    tick.current = 0; // the first poll also refreshes the member list
    void hydrateChat(id).then(() => {
      if (live) void poll();
    });
    // Shown from the cache when there is one; this refreshes it in the background.
    api<GroupInfo>(`/api/groups/${id}`).then(
      async (i) => {
        if (await checkUser(i.userId)) setChatInfo(id, i);
      },
      (e) => {
        if (isGone(e)) dropChat(id);
        setError((e as Error).message);
      },
    );
    return () => {
      live = false;
    };
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
    if (/@splitbot\b/i.test(body)) track("bot_request", { edit: replyToId != null });
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
