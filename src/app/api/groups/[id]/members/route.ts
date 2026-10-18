import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { body, json, requireMember, route } from "@/lib/server/http";
import { addMemberByPhone, requireOwner } from "@/lib/server/membership";
import { postMessage } from "@/lib/server/messages";

type Ctx = { params: Promise<{ id: string }> };

const Add = z.object({
  phone: z.string().trim().min(10, "Enter a mobile number.").max(20),
  name: z.string().trim().max(40).optional(),
});

/** Owner adds someone by mobile number (from their contacts, or typed and looked up). */
export const POST = route<Ctx>(async (req, ctx) => {
  const { id } = await ctx.params;
  const { user, group, me } = await requireMember(id);
  requireOwner(group, user);
  const input = await body(req, Add);
  const count = (await db.select({ id: schema.members.id }).from(schema.members).where(eq(schema.members.groupId, group.id))).length;
  const m = await addMemberByPhone(db, { groupId: group.id, name: input.name, phone: input.phone, colorIndex: count });
  await postMessage({ groupId: group.id, kind: "system", body: `${me.name} added ${m.name}.` });
  return json({ id: m.id, name: m.name, onSplitBot: Boolean(m.userId) });
});
