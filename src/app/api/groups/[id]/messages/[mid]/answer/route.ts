import { and, eq, sql } from "drizzle-orm";
import { after } from "next/server";
import { z } from "zod";
import { db, schema } from "@/db";
import { answerClarification } from "@/lib/bot/orchestrator";
import type { Question } from "@/lib/bot/spec";
import type { Overrides } from "@/lib/bot/types";
import { body, HttpError, json, requireMember, route } from "@/lib/server/http";
import { setBotBusy } from "@/lib/server/messages";

type Ctx = { params: Promise<{ id: string; mid: string }> };

/**
 * Answer a clarification. The client sends the option index (or the chosen
 * members for multi-select); patches are read from the stored question, never
 * from the client.
 */
export const POST = route<Ctx>(async (req, ctx) => {
  const { id, mid } = await ctx.params;
  const { group, me } = await requireMember(id);
  const input = await body(
    req,
    z.object({ option: z.number().int().min(0).optional(), participants: z.array(z.string()).min(1).optional() }),
  );
  const [msg] = await db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.id, Number(mid)), eq(schema.messages.groupId, group.id)));
  if (!msg || msg.kind !== "clarify") throw new HttpError(404, "Question not found.");
  const data = (msg.data ?? {}) as { question?: Question; answered?: unknown };
  if (data.answered) throw new HttpError(409, "Someone already answered this.");
  const q = data.question;
  if (!q) throw new HttpError(400, "Malformed question.");

  let patch: Overrides;
  let label: string;
  if (q.multi && input.participants) {
    const members = await db.select().from(schema.members).where(eq(schema.members.groupId, group.id));
    const ids = new Set(members.map((m) => m.id));
    const chosen = input.participants.filter((p) => ids.has(p));
    if (!chosen.length) throw new HttpError(400, "Pick at least one person.");
    patch = { participants: chosen };
    label = chosen.map((c) => members.find((m) => m.id === c)?.name).join(", ");
  } else if (input.option !== undefined && q.options[input.option]) {
    patch = q.options[input.option].patch;
    label = q.options[input.option].label;
  } else {
    throw new HttpError(400, "Pick an option.");
  }

  // Claim the question atomically so two people tapping at once can't both answer.
  const claimed = await db
    .update(schema.messages)
    .set({
      updatedAt: new Date(),
      data: sql`coalesce(${schema.messages.data}, '{}'::jsonb) || ${JSON.stringify({ answered: { label, byMemberId: me.id } })}::jsonb`,
    })
    .where(and(eq(schema.messages.id, msg.id), sql`not (coalesce(${schema.messages.data}, '{}'::jsonb) ? 'answered')`))
    .returning({ id: schema.messages.id });
  if (!claimed.length) throw new HttpError(409, "Someone already answered this.");
  await setBotBusy(group.id, "Working on it…");
  after(async () => {
    try {
      await answerClarification(group, me, msg.id, patch);
    } finally {
      await setBotBusy(group.id, null);
    }
  });
  return json({ ok: true });
});
