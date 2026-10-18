import "server-only";
import { eq, isNull, or } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Group, Member, User } from "@/db/schema";
import { PALETTE } from "@/lib/colors";
import { normalisePhone } from "@/lib/phone";
import { canClaim, isOwner } from "@/lib/membershipRules";
import { HttpError } from "./http";

export { canClaim, isOwner };

type Db = Pick<typeof db, "select" | "insert">;

export function requireOwner(group: Pick<Group, "createdBy">, user: Pick<User, "id">) {
  if (!isOwner(group, user)) throw new HttpError(403, "Only the group owner can add people. Share the invite link instead.");
}

/**
 * Add someone by mobile number (picked from contacts, or typed and looked up). If they're
 * already on SplitBot they're linked straight away; otherwise they're a placeholder that links
 * automatically when they sign up with that number.
 */
export async function addMemberByPhone(
  tx: Db,
  opts: { groupId: string; name: string | undefined; phone: string; colorIndex: number },
): Promise<Member> {
  const phone = normalisePhone(opts.phone);
  if (!phone) throw new HttpError(400, "That mobile number doesn't look right.");
  const [user] = await tx.select().from(schema.users).where(eq(schema.users.phone, phone));
  const name = (user?.name ?? opts.name ?? "").trim().slice(0, 40);
  if (!name) throw new HttpError(400, "Add a name for this person.");

  const existing = await tx.select().from(schema.members).where(eq(schema.members.groupId, opts.groupId));
  const same = existing.find((m) => m.phone === phone || (user && m.userId === user.id));
  if (same) throw new HttpError(409, `${same.name} is already in the group.`);
  if (existing.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
    throw new HttpError(409, `There's already a ${name} in this group. Use a surname or nickname.`);
  }
  const [m] = await tx
    .insert(schema.members)
    .values({ groupId: opts.groupId, userId: user?.id ?? null, name, phone, color: PALETTE[opts.colorIndex % PALETTE.length] })
    .returning();
  return m;
}

/** Exact-number lookup for the "add by number" box. Never a prefix search, so numbers can't be enumerated. */
export async function lookupByPhone(raw: string) {
  const phone = normalisePhone(raw);
  if (!phone) throw new HttpError(400, "Enter a full 10-digit mobile number.");
  const [user] = await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.phone, phone));
  return { phone, onSplitBot: Boolean(user), name: user?.name ?? null };
}

/** SQL form of `canClaim` (see membershipRules.ts). */
export function claimableBy(user: Pick<User, "phone">) {
  return or(isNull(schema.members.phone), eq(schema.members.phone, user.phone));
}

