import { after } from "next/server";
import { and, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { handleMention } from "@/lib/bot/orchestrator";
import { body, json, requireMember, route } from "@/lib/server/http";
import { fetchMessages, postMessage, setBotBusy } from "@/lib/server/messages";
import { notifyGroup } from "@/lib/server/push";
import { memberViews } from "@/lib/server/views";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (req, ctx) => {
  const { id } = await ctx.params;
  const { group, me } = await requireMember(id);
  const url = new URL(req.url);
  const after = Number(url.searchParams.get("after") ?? 0) || 0;
  const sinceRaw = url.searchParams.get("since");
  const since = sinceRaw ? new Date(sinceRaw) : null;

  const { messages, maxUpdated, truncated, hasMore } = await fetchMessages(group.id, after, since && !isNaN(+since) ? since : null);
  const maxId = messages.reduce((m, x) => Math.max(m, x.id), after);
  // Independent of each other, so run them side by side. The bot-typing flag comes from the
  // group row requireMember already loaded, saving a query on every poll.
  const [members] = await Promise.all([
    url.searchParams.get("members") ? memberViews(group.id) : undefined,
    maxId > me.lastReadMessageId &&
      db
        .update(schema.members)
        .set({ lastReadMessageId: maxId })
        .where(and(eq(schema.members.id, me.id), lt(schema.members.lastReadMessageId, maxId))),
  ]);

  return json({
    messages,
    truncated,
    hasMore,
    cursor: { after: maxId, since: (maxUpdated ?? new Date(0)).toISOString() },
    botBusy: group.botBusyUntil && group.botBusyUntil > new Date() ? (group.botBusyLabel ?? "Thinking…") : null,
    members,
  });
});

const Send = z.object({
  body: z.string().trim().min(1).max(2000),
  replyToId: z.number().int().positive().nullable().optional(),
});

export const POST = route<Ctx>(async (req, ctx) => {
  const { id } = await ctx.params;
  const { group, me } = await requireMember(id);
  const input = await body(req, Send);
  const msg = await postMessage({ groupId: group.id, kind: "text", body: input.body, senderMemberId: me.id, replyToId: input.replyToId ?? null });
  notifyGroup(group.id, { exceptMemberId: me.id }, { title: group.name, body: `${me.name}: ${input.body}`, url: `/g/${group.id}`, tag: `chat-${group.id}` });

  if (/@splitbot\b/i.test(input.body)) {
    await setBotBusy(group.id, "Reading that…");
    after(() =>
      handleMention({ group, sender: me, text: input.body, sourceMessageId: msg.id, replyToId: input.replyToId ?? null }),
    );
  }
  return json({ id: msg.id });
});
