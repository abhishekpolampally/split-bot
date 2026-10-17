import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { PALETTE } from "@/lib/colors";
import { normalisePhone } from "@/lib/server/auth";
import { body, HttpError, json, requireMember, route } from "@/lib/server/http";
import { postMessage } from "@/lib/server/messages";

type Ctx = { params: Promise<{ id: string }> };

export const POST = route<Ctx>(async (req, ctx) => {
  const { id } = await ctx.params;
  const { group, me } = await requireMember(id);
  const input = await body(req, z.object({ name: z.string().trim().min(1, "Enter a name.").max(40), phone: z.string().max(20).optional() }));
  const phone = input.phone ? normalisePhone(input.phone) : null;
  if (input.phone && !phone) throw new HttpError(400, "That phone number doesn't look right.");

  const existing = await db.select().from(schema.members).where(eq(schema.members.groupId, group.id));
  if (existing.some((m) => m.name.toLowerCase() === input.name.toLowerCase())) {
    throw new HttpError(400, `There's already a ${input.name} in this group. Use a surname or nickname.`);
  }
  let userId: string | null = null;
  if (phone) {
    const [u] = await db.select().from(schema.users).where(eq(schema.users.phone, phone));
    if (u) {
      const [already] = await db
        .select()
        .from(schema.members)
        .where(and(eq(schema.members.groupId, group.id), eq(schema.members.userId, u.id)));
      if (already) throw new HttpError(400, `${already.name} is already in the group.`);
      userId = u.id;
    }
  }
  const [m] = await db
    .insert(schema.members)
    .values({ groupId: group.id, userId, name: input.name, phone, color: PALETTE[existing.length % PALETTE.length] })
    .returning();
  await postMessage({ groupId: group.id, kind: "system", body: `${me.name} added ${m.name}.` });
  return json({ id: m.id });
});
