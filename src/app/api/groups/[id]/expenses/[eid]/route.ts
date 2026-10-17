import { json, requireMember, route } from "@/lib/server/http";
import { deleteExpense } from "@/lib/server/proposals";

type Ctx = { params: Promise<{ id: string; eid: string }> };

export const DELETE = route<Ctx>(async (_req, ctx) => {
  const { id, eid } = await ctx.params;
  const { group, me } = await requireMember(id);
  await deleteExpense(group.id, eid, me);
  return json({ ok: true });
});
