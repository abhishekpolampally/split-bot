import { json, requireMember, route } from "@/lib/server/http";
import { groupLedger } from "@/lib/server/ledger";
import { memberViews } from "@/lib/server/views";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, ctx) => {
  const { id } = await ctx.params;
  const { group, me } = await requireMember(id);
  const [ledger, members] = await Promise.all([groupLedger(group.id), memberViews(group.id)]);
  const activity = [
    ...ledger.expenses.map((e) => ({
      type: "expense" as const,
      id: e.id,
      title: e.description,
      category: e.category,
      payerMemberId: e.payerMemberId,
      totalPaise: e.totalPaise,
      myShare: e.shares[me.id] ?? 0,
      shares: e.shares,
      at: e.createdAt.toISOString(),
    })),
    ...ledger.settlements.map((s) => ({
      type: "settlement" as const,
      id: s.id,
      from: s.fromMemberId,
      to: s.toMemberId,
      amountPaise: s.amountPaise,
      method: s.method,
      at: s.createdAt.toISOString(),
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return json({
    group: { id: group.id, name: group.name },
    meId: me.id,
    members,
    net: ledger.net,
    transfers: ledger.transfers,
    activity,
    totalSpendPaise: ledger.expenses.reduce((s, e) => s + e.totalPaise, 0),
  });
});
