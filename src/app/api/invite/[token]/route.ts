import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { PALETTE } from "@/lib/colors";
import { body, HttpError, json, requireUser, route } from "@/lib/server/http";
import { postMessage } from "@/lib/server/messages";

type Ctx = { params: Promise<{ token: string }> };

async function groupByToken(token: string) {
  const [g] = await db.select().from(schema.groups).where(eq(schema.groups.inviteToken, token));
  if (!g) throw new HttpError(404, "This invite link isn't valid any more.");
  return g;
}

export const GET = route<Ctx>(async (_req, ctx) => {
  const { token } = await ctx.params;
  const user = await requireUser();
  const g = await groupByToken(token);
  const members = await db.select().from(schema.members).where(eq(schema.members.groupId, g.id));
  const mine = members.find((m) => m.userId === user.id);
  return json({
    group: { id: g.id, name: g.name, color: g.color },
    alreadyMember: Boolean(mine),
    members: members.map((m) => ({ id: m.id, name: m.name, color: m.color, isPlaceholder: !m.userId })),
  });
});

export const POST = route<Ctx>(async (req, ctx) => {
  const { token } = await ctx.params;
  const user = await requireUser();
  if (!user.name) throw new HttpError(400, "Set your name first.");
  const g = await groupByToken(token);
  const { claimMemberId } = await body(req, z.object({ claimMemberId: z.string().nullable().optional() }));

  const [existing] = await db
    .select()
    .from(schema.members)
    .where(and(eq(schema.members.groupId, g.id), eq(schema.members.userId, user.id)));
  if (existing) return json({ groupId: g.id });

  if (claimMemberId) {
    const claimed = await db
      .update(schema.members)
      .set({ userId: user.id, phone: user.phone })
      .where(and(eq(schema.members.id, claimMemberId), eq(schema.members.groupId, g.id), isNull(schema.members.userId)))
      .returning();
    if (!claimed.length) throw new HttpError(409, "Someone already claimed that name.");
    await postMessage({ groupId: g.id, kind: "system", body: `${claimed[0].name} joined via invite link.` });
    return json({ groupId: g.id });
  }

  const count = (await db.select().from(schema.members).where(eq(schema.members.groupId, g.id))).length;
  await db.insert(schema.members).values({
    groupId: g.id,
    userId: user.id,
    name: user.name,
    phone: user.phone,
    color: PALETTE[count % PALETTE.length],
  });
  await postMessage({ groupId: g.id, kind: "system", body: `${user.name} joined via invite link.` });
  return json({ groupId: g.id });
});
