"use client";

import { ArrowRight, Plus, X } from "lucide-react";
import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Avatar, BotAvatar, cx } from "@/components/ui";
import type { MessageView } from "@/lib/types";
import { useChat } from "./context";

export interface ComposerHandle {
  prefill: (text: string, replyTo?: MessageView | null) => void;
}

interface Props {
  onSend: (body: string, replyToId: number | null) => Promise<void>;
  onAddExpense: () => void;
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer({ onSend, onAddExpense }, ref) {
  const chat = useChat();
  const [text, setText] = useState("");
  const [reply, setReply] = useState<MessageView | null>(null);
  const [sending, setSending] = useState(false);
  const [caret, setCaret] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    prefill(t, replyTo) {
      setText((cur) => (cur.trim() ? cur : t));
      if (replyTo !== undefined) setReply(replyTo);
      requestAnimationFrame(() => {
        const el = ta.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
        setCaret(el.value.length);
      });
    },
  }));

  // @mention autocomplete: the word being typed at the caret.
  const mention = useMemo(() => {
    const before = text.slice(0, caret);
    const m = before.match(/(?:^|\s)@([\p{L}]*)$/u);
    if (!m) return null;
    const q = m[1].toLowerCase();
    const options = [
      { key: "splitbot", label: "SplitBot", insert: "@splitbot ", bot: true as const },
      ...chat.members
        .filter((x) => x.id !== chat.meId)
        .map((x) => ({ key: x.id, label: x.name, insert: `@${x.name.split(/\s+/)[0]} `, bot: false as const, member: x })),
    ].filter((o) => o.label.toLowerCase().startsWith(q) || (o.bot && "splitbot".startsWith(q)));
    return options.length ? { start: before.length - m[1].length - 1, options } : null;
  }, [text, caret, chat.members, chat.meId]);

  function pick(insert: string) {
    if (!mention) return;
    const next = text.slice(0, mention.start) + insert + text.slice(caret);
    setText(next);
    const pos = mention.start + insert.length;
    requestAnimationFrame(() => {
      ta.current?.focus();
      ta.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  }

  async function send() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await onSend(body, reply?.id ?? null);
      setText("");
      setReply(null);
      setCaret(0);
    } finally {
      setSending(false);
      ta.current?.focus();
    }
  }

  const hasMention = /@splitbot\b/i.test(text);
  const rows = Math.min(5, text.split("\n").length + Math.floor(text.length / 34));

  return (
    <div className="relative shrink-0 border-t border-edge bg-surface px-2.5 pb-[max(14px,env(safe-area-inset-bottom))] pt-2">
      {mention && (
        <div className="absolute bottom-full left-2.5 right-2.5 mb-1 overflow-hidden rounded-xl border border-edge bg-white shadow-lg">
          {mention.options.slice(0, 6).map((o) => (
            <button
              key={o.key}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(o.insert)}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-surface"
            >
              {o.bot ? <BotAvatar /> : <Avatar name={o.label} color={o.member!.color} />}
              <span className="font-bold">{o.bot ? "@splitbot" : o.label}</span>
              {o.bot && <span className="text-xs text-muted">log or split an expense</span>}
            </button>
          ))}
        </div>
      )}

      {reply && (
        <div className="mb-2 flex items-center gap-2 rounded-xl border border-edge bg-white px-3 py-2">
          <div className="min-w-0 flex-1 border-l-[3px] border-brand pl-2">
            <div className="text-xs font-bold text-brand">
              Replying to {reply.senderMemberId ? chat.display(reply.senderMemberId) : "SplitBot"}
            </div>
            <div className="truncate text-xs text-muted">{reply.body}</div>
          </div>
          <button aria-label="Cancel reply" onClick={() => setReply(null)} className="text-muted">
            <X size={18} />
          </button>
        </div>
      )}

      <div className="flex items-end gap-1.5">
        <button
          aria-label="Add expense manually"
          onClick={onAddExpense}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted"
        >
          <Plus size={22} />
        </button>
        <div className="flex min-h-11 flex-1 items-end rounded-[22px] border border-edge bg-white focus-within:border-brand">
          <textarea
            ref={ta}
            value={text}
            rows={Math.max(1, rows)}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
            }}
            onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
            onKeyDown={(e) => {
              if (mention && (e.key === "Enter" || e.key === "Tab")) {
                e.preventDefault();
                pick(mention.options[0].insert);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Message, or tag @splitbot"
            className="no-scrollbar max-h-32 flex-1 resize-none bg-transparent py-[11px] pl-3.5 text-[15px] leading-snug outline-none placeholder:text-faint"
          />
          {!text && (
            <button
              onClick={() => {
                setText("@splitbot ");
                setCaret(10);
                requestAnimationFrame(() => {
                  ta.current?.focus();
                  ta.current?.setSelectionRange(10, 10);
                });
              }}
              className="m-1.5 h-8 shrink-0 rounded-full bg-tint px-3 text-[13px] font-extrabold text-brand"
            >
              Split
            </button>
          )}
        </div>
        <button
          onClick={send}
          disabled={!text.trim() || sending}
          aria-label="Send"
          className={cx(
            "flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white transition-colors",
            text.trim() ? (hasMention ? "bg-brand" : "bg-brand") : "bg-[#A9B8B1]",
          )}
        >
          <ArrowRight size={20} strokeWidth={2.2} />
        </button>
      </div>
    </div>
  );
});
