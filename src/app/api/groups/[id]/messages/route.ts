import { after } from "next/server";
import { and, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { handleMention } from "@/lib/bot/orchestrator";
import { body, json, requireMember, route } from "@/lib/server/http";
import { fetchMessages, postMessage, setBotBusy } from "@/lib/server/messages";
import { memberViews } from "@/lib/server/views";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (req, ctx) => {
  const { id } = await ctx.params;
  const { group, me } = await requireMember(id);
  const url = new URL(req.url);
  const after = Number(url.searchParams.get("after") ?? 0) || 0;
  const sinceRaw = url.searchParams.get("since");
  const since = sinceRaw ? new Date(sinceRaw) : null;

  const { messages, maxUpdated } = await fetchMessages(group.id, after, since && !isNaN(+since) ? since : null);
  const maxId = messages.reduce((m, x) => Math.max(m, x.id), after);
  if (maxId > me.lastReadMessageId) {
    await db
      .update(schema.members)
      .set({ lastReadMessageId: maxId })
      .where(and(eq(schema.members.id, me.id), lt(schema.members.lastReadMessageId, maxId)));
  }
  const [g] = await db
    .select({ until: schema.groups.botBusyUntil, label: schema.groups.botBusyLabel })
    .from(schema.groups)
    .where(eq(schema.groups.id, group.id));

  return json({
    messages,
    cursor: { after: maxId, since: (maxUpdated ?? new Date(0)).toISOString() },
    botBusy: g?.until && g.until > new Date() ? (g.label ?? "Thinking…") : null,
    members: url.searchParams.get("members") ? await memberViews(group.id) : undefined,
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

  if (/@splitbot\b/i.test(input.body)) {
    await setBotBusy(group.id, "Reading that…");
    after(() =>
      handleMention({ group, sender: me, text: input.body, sourceMessageId: msg.id, replyToId: input.replyToId ?? null }),
    );
  }
  return json({ id: msg.id });
});
