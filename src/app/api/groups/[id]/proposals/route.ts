import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { body, HttpError, json, requireMember, route } from "@/lib/server/http";
import { createProposal } from "@/lib/server/proposals";
import { SpecSchema } from "@/lib/server/specSchema";
import { computeSplit } from "@/lib/split/engine";

type Ctx = { params: Promise<{ id: string }> };

/** Manual "Add expense" form: goes through the same proposal → confirm path as the bot. */
export const POST = route<Ctx>(async (req, ctx) => {
  const { id } = await ctx.params;
  const { group, me } = await requireMember(id);
  const spec = await body(req, SpecSchema);
  const members = await db.select().from(schema.members).where(eq(schema.members.groupId, group.id));
  const ids = new Set(members.map((m) => m.id));
  if (!ids.has(spec.payerId) || spec.participants.some((p) => !ids.has(p))) throw new HttpError(400, "Everyone must be in the group.");
  const result = computeSplit(spec);
  if (!result.ok) throw new HttpError(400, result.errors.join(" "));
  const p = await createProposal({
    groupId: group.id,
    senderMemberId: me.id,
    sourceMessageId: null,
    spec,
    flags: spec.payerId !== me.id ? ["payer"] : [],
    intro: `${me.name} added an expense:`,
  });
  return json({ id: p.id });
});
