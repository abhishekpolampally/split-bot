"use client";

import Link from "next/link";
import { Check, CornerUpLeft } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { Avatar, BotAvatar, Button, cx } from "@/components/ui";
import { api, clockLabel } from "@/lib/client";
import { initials } from "@/lib/colors";
import { formatINR } from "@/lib/money";
import type { MessageView, Question, Transfer } from "@/lib/types";
import { useChat } from "./context";
import { ProposalCard } from "./ProposalCard";

export function MessageItem({ msg, prev, replyTarget }: { msg: MessageView; prev?: MessageView; replyTarget?: MessageView }) {
  const chat = useChat();
  switch (msg.kind) {
    case "system":
      return <div className="self-center rounded-lg bg-surface px-2.5 py-1 text-center text-xs text-muted">{msg.body}</div>;
    case "proposal":
      return msg.proposal ? <ProposalCard msg={msg} p={msg.proposal} /> : null;
    case "clarify":
      return <ClarifyCard msg={msg} />;
    case "summary":
      return <TransfersCard msg={msg} actions />;
    case "settle":
      return <TransfersCard msg={msg} settle />;
    case "bot_text":
      return <BotText msg={msg} />;
    default: {
      const mine = msg.senderMemberId === chat.meId;
      const sender = chat.member(msg.senderMemberId);
      const grouped = prev && prev.kind === "text" && prev.senderMemberId === msg.senderMemberId;
      const quote = replyTarget ? (
        <div className="mb-1 rounded-md border-l-[3px] border-brand bg-black/5 px-2 py-1 text-xs text-muted">
          <span className="font-bold">{replyTarget.senderMemberId ? chat.display(replyTarget.senderMemberId) : "SplitBot"}</span>{" "}
          <span className="line-clamp-1">{replyTarget.body}</span>
        </div>
      ) : null;
      if (mine) {
        return (
          <div className={cx("max-w-[270px] self-end rounded-[14px_14px_4px_14px] bg-me px-3 py-2", grouped && "-mt-1.5")}>
            {quote}
            <div className="whitespace-pre-wrap break-words text-[15px] leading-snug">
              <RichText text={msg.body} />
            </div>
            <div className="text-right text-[11px] text-me-ink">{clockLabel(msg.createdAt)}</div>
          </div>
        );
      }
      return (
        <div className={cx("flex items-end gap-2", grouped && "-mt-1.5")}>
          {grouped ? <span className="w-7 shrink-0" /> : <Avatar name={sender?.name ?? "?"} color={sender?.color ?? "#999"} />}
          <div className="max-w-[270px] rounded-[14px_14px_14px_4px] bg-white px-3 py-2">
            {!grouped && (
              <div className="text-xs font-bold" style={{ color: sender?.color }}>
                {sender?.name ?? "Former member"}
              </div>
            )}
            {quote}
            <div className="whitespace-pre-wrap break-words text-[15px] leading-snug">
              <RichText text={msg.body} />
            </div>
            <div className="text-right text-[11px] text-muted">{clockLabel(msg.createdAt)}</div>
          </div>
        </div>
      );
    }
  }
}

/** Highlights @splitbot and @Name mentions like the prototype. */
export function RichText({ text }: { text: string }) {
  const parts = text.split(/(@[\p{L}]+)/u);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("@") ? (
          <span key={i} className="font-bold text-brand">
            {p}
          </span>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

function BotShell({ children, width = 270 }: { children: ReactNode; width?: number }) {
  return (
    <div className="flex items-start gap-2">
      <BotAvatar />
      <div className="flex flex-col gap-1.5 rounded-[14px_14px_14px_4px] bg-white px-3 py-2.5" style={{ width, maxWidth: "calc(100% - 36px)" }}>
        <div className="text-xs font-bold text-brand">SplitBot</div>
        {children}
      </div>
    </div>
  );
}

function ActionButtons({ actions }: { actions: string[] }) {
  const chat = useChat();
  return (
    <div className="mt-1 flex gap-2">
      {actions.includes("balances") && (
        <Link
          href={`/g/${chat.groupId}/balances`}
          className="flex h-10 flex-1 items-center justify-center rounded-[10px] border-[1.5px] border-brand bg-white text-[13px] font-bold text-brand"
        >
          View balances
        </Link>
      )}
      {actions.includes("settle") && (
        <Link
          href={`/g/${chat.groupId}/settle`}
          className="flex h-10 flex-1 items-center justify-center rounded-[10px] bg-brand text-[13px] font-bold text-white"
        >
          Settle up
        </Link>
      )}
    </div>
  );
}

function BotText({ msg }: { msg: MessageView }) {
  const data = (msg.data ?? {}) as { lines?: { who: string; amountPaise: number }[]; actions?: string[] };
  return (
    <BotShell>
      <div className="whitespace-pre-line text-sm leading-snug">{msg.body}</div>
      {data.lines?.map((l, i) => (
        <div key={i} className="flex justify-between gap-3 text-sm">
          <span className="truncate">{l.who}</span>
          <span className="font-extrabold">{formatINR(l.amountPaise)}</span>
        </div>
      ))}
      {data.actions && <ActionButtons actions={data.actions} />}
    </BotShell>
  );
}

function TransfersCard({ msg, actions, settle }: { msg: MessageView; actions?: boolean; settle?: boolean }) {
  const chat = useChat();
  const transfers = ((msg.data ?? {}) as { transfers?: Transfer[] }).transfers ?? [];
  const sentence = (t: Transfer) => {
    if (t.to === chat.meId) return `${chat.display(t.from)} owes you`;
    if (t.from === chat.meId) return `You owe ${chat.display(t.to)}`;
    return `${chat.display(t.from)} owes ${chat.display(t.to)}`;
  };
  return (
    <BotShell>
      <div className="text-sm leading-snug">{msg.body}</div>
      {transfers.map((t, i) => (
        <div key={i} className="flex justify-between gap-3 text-sm">
          <span className={cx("truncate", (t.to === chat.meId || t.from === chat.meId) && "font-semibold")}>{sentence(t)}</span>
          <span className="font-extrabold">{formatINR(t.amountPaise)}</span>
        </div>
      ))}
      {(actions || settle) && <ActionButtons actions={settle ? ["settle"] : transfers.length ? ["balances", "settle"] : ["balances"]} />}
    </BotShell>
  );
}

function ClarifyCard({ msg }: { msg: MessageView }) {
  const chat = useChat();
  const data = (msg.data ?? {}) as { question?: Question; answered?: { label: string; byMemberId: string } };
  const q = data.question;
  const [selected, setSelected] = useState<string[]>(q?.multi?.preselected ?? []);
  const [busy, setBusy] = useState<number | "multi" | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!q) return null;
  const answered = data.answered;

  async function answer(payload: { option?: number; participants?: string[] }, key: number | "multi") {
    setBusy(key);
    setError(null);
    try {
      await api(`/api/groups/${chat.groupId}/messages/${msg.id}/answer`, { body: payload });
      chat.refresh();
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  return (
    <BotShell width={300}>
      <div className="text-sm font-semibold leading-snug">{q.text}</div>
      {answered ? (
        <div className="flex items-center gap-1.5 text-[13px] font-bold text-brand">
          <Check size={15} strokeWidth={2.6} /> {answered.label}
          <span className="font-semibold text-muted">· {chat.display(answered.byMemberId)}</span>
        </div>
      ) : q.multi ? (
        <>
          <div className="flex flex-wrap gap-1.5">
            {chat.members.map((m) => {
              const on = selected.includes(m.id);
              return (
                <button
                  key={m.id}
                  onClick={() => setSelected(on ? selected.filter((x) => x !== m.id) : [...selected, m.id])}
                  aria-pressed={on}
                  className="flex h-9 items-center gap-1.5 rounded-full border-[1.5px] pl-1 pr-3 text-[13px] font-bold"
                  style={{ borderColor: on ? m.color : "#C5CCD3", background: on ? m.color : "#fff", color: on ? "#fff" : "#12201B" }}
                >
                  <span
                    className="flex h-7 w-7 items-center justify-center rounded-full text-[11px]"
                    style={{ background: on ? "rgba(255,255,255,.25)" : m.color, color: "#fff" }}
                  >
                    {initials(m.name)}
                  </span>
                  {chat.display(m.id)}
                </button>
              );
            })}
          </div>
          <Button className="mt-1 h-10" disabled={!selected.length} loading={busy === "multi"} onClick={() => answer({ participants: selected }, "multi")}>
            Split between {selected.length || "…"}
          </Button>
        </>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {q.options.map((o, i) => (
            <button
              key={i}
              disabled={busy !== null}
              onClick={() => answer({ option: i }, i)}
              className="min-h-9 rounded-full border-[1.5px] border-brand bg-white px-3 py-1 text-[13px] font-bold text-brand disabled:opacity-50"
            >
              {busy === i ? "…" : o.label}
            </button>
          ))}
        </div>
      )}
      {q.hint && !answered && <div className="text-xs text-muted">{q.hint}</div>}
      {error && <div className="text-xs font-semibold text-owe">{error}</div>}
      {!answered && (
        <button className="flex items-center gap-1 self-start text-xs font-bold text-muted" onClick={() => chat.replyTo(msg.id, "@splitbot ")}>
          <CornerUpLeft size={13} /> Or reply in words
        </button>
      )}
    </BotShell>
  );
}

export function Typing({ label }: { label: string }) {
  return (
    <div className="flex items-end gap-2">
      <BotAvatar />
      <div className="flex flex-col gap-1 rounded-[14px_14px_14px_4px] bg-white px-3.5 py-2.5">
        <div className="text-xs text-muted">{label}</div>
        <div className="flex gap-1">
          <span className="sbd1 h-[7px] w-[7px] rounded-full bg-brand" />
          <span className="sbd2 h-[7px] w-[7px] rounded-full bg-brand" />
          <span className="sbd3 h-[7px] w-[7px] rounded-full bg-brand" />
        </div>
      </div>
    </div>
  );
}
