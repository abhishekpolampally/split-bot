import "server-only";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";

export interface MemberView {
  id: string;
  name: string;
  color: string;
  isPlaceholder: boolean;
  upiId: string | null;
}

export async function memberViews(groupId: string): Promise<MemberView[]> {
  const rows = await db
    .select({ m: schema.members, upiId: schema.users.upiId })
    .from(schema.members)
    .leftJoin(schema.users, eq(schema.users.id, schema.members.userId))
    .where(eq(schema.members.groupId, groupId))
    .orderBy(asc(schema.members.joinedAt));
  return rows.map(({ m, upiId }) => ({
    id: m.id,
    name: m.name,
    color: m.color,
    isPlaceholder: !m.userId,
    upiId: upiId ?? null,
  }));
}
