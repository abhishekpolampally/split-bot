import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { formatINR } from "@/lib/money";
import { body, HttpError, json, requireMember, route } from "@/lib/server/http";
import { postMessage } from "@/lib/server/messages";
import { notifyGroup } from "@/lib/server/push";

type Ctx = { params: Promise<{ id: string }> };

const Input = z.object({
  fromMemberId: z.string(),
  toMemberId: z.string(),
  amountPaise: z.number().int().positive().max(1_000_000_000),
  method: z.enum(["upi", "cash"]).default("upi"),
});

/** Record a settle-up payment. Either side can record it: payer says "I've paid", receiver says "got it". */
export const POST = route<Ctx>(async (req, ctx) => {
  const { id } = await ctx.params;
  const { group, me } = await requireMember(id);
  const input = await body(req, Input);
  if (input.fromMemberId === input.toMemberId) throw new HttpError(400, "Pick two different people.");
  const members = await db.select().from(schema.members).where(eq(schema.members.groupId, group.id));
  const from = members.find((m) => m.id === input.fromMemberId);
  const to = members.find((m) => m.id === input.toMemberId);
  if (!from || !to) throw new HttpError(400, "Both people must be in the group.");
  const involved = me.id === from.id || me.id === to.id;
  // Placeholders can't record payments themselves, so anyone may record on their behalf.
  if (!involved && from.userId && to.userId) throw new HttpError(403, "Only the two people involved can record this payment.");

  await db.insert(schema.settlements).values({ groupId: group.id, ...input, createdByMemberId: me.id });
  await postMessage({
    groupId: group.id,
    kind: "bot_text",
    body: `${from.name} paid ${to.name} ${formatINR(input.amountPaise)}${input.method === "cash" ? " in cash" : " via UPI"}. Recorded by ${me.name}.`,
    data: { settlement: true, actions: ["balances"] },
  });
  notifyGroup(
    group.id,
    { memberIds: [from.id, to.id], exceptMemberId: me.id },
    { body: `${from.name} paid ${to.name} ${formatINR(input.amountPaise)}. Balances are updated.`, url: `/g/${group.id}/balances` },
  );
  return json({ ok: true });
});
