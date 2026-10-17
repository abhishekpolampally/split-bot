import "server-only";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Member } from "@/db/schema";
import { simplifyDebts, type Transfer } from "@/lib/split/simplify";

export interface LedgerExpense {
  id: string;
  description: string;
  category: string;
  payerMemberId: string;
  totalPaise: number;
  createdAt: Date;
  sourceMessageId: number | null;
  shares: Record<string, number>;
}

export interface Ledger {
  members: Member[];
  net: Record<string, number>;
  transfers: Transfer[];
  expenses: LedgerExpense[];
  settlements: (typeof schema.settlements.$inferSelect)[];
}

export async function groupLedger(groupId: string): Promise<Ledger> {
  const [members, expenses, settlements] = await Promise.all([
    db.select().from(schema.members).where(eq(schema.members.groupId, groupId)).orderBy(asc(schema.members.joinedAt)),
    db
      .select()
      .from(schema.expenses)
      .where(and(eq(schema.expenses.groupId, groupId), isNull(schema.expenses.deletedAt)))
      .orderBy(desc(schema.expenses.createdAt)),
    db
      .select()
      .from(schema.settlements)
      .where(eq(schema.settlements.groupId, groupId))
      .orderBy(desc(schema.settlements.createdAt)),
  ]);
  const shares = expenses.length
    ? await db
        .select()
        .from(schema.expenseShares)
        .where(inArray(schema.expenseShares.expenseId, expenses.map((e) => e.id)))
    : [];

  const net: Record<string, number> = Object.fromEntries(members.map((m) => [m.id, 0]));
  const byExpense = new Map<string, Record<string, number>>();
  for (const s of shares) {
    const rec = byExpense.get(s.expenseId) ?? {};
    rec[s.memberId] = (rec[s.memberId] ?? 0) + s.amountPaise;
    byExpense.set(s.expenseId, rec);
    net[s.memberId] = (net[s.memberId] ?? 0) - s.amountPaise;
  }
  for (const e of expenses) net[e.payerMemberId] = (net[e.payerMemberId] ?? 0) + e.totalPaise;
  for (const s of settlements) {
    net[s.fromMemberId] = (net[s.fromMemberId] ?? 0) + s.amountPaise;
    net[s.toMemberId] = (net[s.toMemberId] ?? 0) - s.amountPaise;
  }

  return {
    members,
    net,
    transfers: simplifyDebts(net),
    expenses: expenses.map((e) => ({
      id: e.id,
      description: e.description,
      category: e.category,
      payerMemberId: e.payerMemberId,
      totalPaise: e.totalPaise,
      createdAt: e.createdAt,
      sourceMessageId: e.sourceMessageId,
      shares: byExpense.get(e.id) ?? {},
    })),
    settlements,
  };
}
