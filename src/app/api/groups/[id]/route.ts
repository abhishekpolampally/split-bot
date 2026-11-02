import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { body, json, requireMember, route } from "@/lib/server/http";
import { isOwner } from "@/lib/server/membership";
import { postMessage } from "@/lib/server/messages";
import { memberViews } from "@/lib/server/views";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, ctx) => {
  const { id } = await ctx.params;
  const { user, group, me } = await requireMember(id);
  return json({
    group: { id: group.id, name: group.name, color: group.color, inviteToken: group.inviteToken },
    meId: me.id,
    // Who's asking: the device cache checks it against whose chats it holds.
    userId: user.id,
    isOwner: isOwner(group, user),
    members: await memberViews(group.id),
  });
});

export const PATCH = route<Ctx>(async (req, ctx) => {
  const { id } = await ctx.params;
  const { group, me } = await requireMember(id);
  const input = await body(req, z.object({ name: z.string().trim().min(1).max(50) }));
  await db.update(schema.groups).set({ name: input.name }).where(eq(schema.groups.id, group.id));
  await postMessage({ groupId: group.id, kind: "system", body: `${me.name} renamed the group to “${input.name}”.` });
  return json({ ok: true });
});
