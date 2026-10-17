import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { json, requireUser, route } from "@/lib/server/http";

/** Recent expenses and payments across all my groups. */
export const GET = route(async () => {
  const user = await requireUser();
  const mine = await db
    .select({ memberId: schema.members.id, groupId: schema.members.groupId, groupName: schema.groups.name })
    .from(schema.members)
    .innerJoin(schema.groups, eq(schema.groups.id, schema.members.groupId))
    .where(eq(schema.members.userId, user.id));
  if (!mine.length) return json({ items: [] });
  const groupIds = mine.map((m) => m.groupId);
  const memberIds = mine.map((m) => m.memberId);
  const groupName = new Map(mine.map((m) => [m.groupId, m.groupName]));

  const [expenses, settlements, members] = await Promise.all([
    db
      .select()
      .from(schema.expenses)
      .where(and(inArray(schema.expenses.groupId, groupIds), isNull(schema.expenses.deletedAt)))
      .orderBy(desc(schema.expenses.createdAt))
      .limit(50),
    db.select().from(schema.settlements).where(inArray(schema.settlements.groupId, groupIds)).orderBy(desc(schema.settlements.createdAt)).limit(50),
    db.select().from(schema.members).where(inArray(schema.members.groupId, groupIds)),
  ]);
  const shares = expenses.length
    ? await db
        .select()
        .from(schema.expenseShares)
        .where(and(inArray(schema.expenseShares.expenseId, expenses.map((e) => e.id)), inArray(schema.expenseShares.memberId, memberIds)))
    : [];
  const name = new Map(members.map((m) => [m.id, m.name]));
  const myShare = new Map(shares.map((s) => [s.expenseId, s.amountPaise]));
  const me = new Set(memberIds);

  const items = [
    ...expenses.map((e) => {
      const share = myShare.get(e.id) ?? 0;
      const iPaid = me.has(e.payerMemberId);
      return {
        type: "expense" as const,
        id: e.id,
        groupId: e.groupId,
        groupName: groupName.get(e.groupId) ?? "",
        title: e.description,
        payer: iPaid ? "You" : (name.get(e.payerMemberId) ?? "Someone"),
        totalPaise: e.totalPaise,
        deltaPaise: iPaid ? e.totalPaise - share : -share,
        at: e.createdAt.toISOString(),
      };
    }),
    ...settlements
      .filter((s) => me.has(s.fromMemberId) || me.has(s.toMemberId))
      .map((s) => ({
        type: "settlement" as const,
        id: s.id,
        groupId: s.groupId,
        groupName: groupName.get(s.groupId) ?? "",
        title: me.has(s.fromMemberId) ? `You paid ${name.get(s.toMemberId)}` : `${name.get(s.fromMemberId)} paid you`,
        payer: "",
        totalPaise: s.amountPaise,
        deltaPaise: me.has(s.fromMemberId) ? s.amountPaise : -s.amountPaise,
        at: s.createdAt.toISOString(),
      })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 60);
  return json({ items });
});
