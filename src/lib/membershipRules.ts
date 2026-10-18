import type { Group, Member, User } from "@/db/schema";

/**
 * Who can add people to a group: only its owner (the person who created it). Everyone else
 * joins through the invite link, so nobody can be put into a group, or onto its balances,
 * by a random member.
 */
export function isOwner(group: Pick<Group, "createdBy">, user: Pick<User, "id">) {
  return group.createdBy != null && group.createdBy === user.id;
}

/**
 * An invite-link joiner may claim a placeholder only if it has no number (added by name before
 * phone numbers were required) or its number is theirs; otherwise anyone could take over a
 * friend's spot and balances.
 */
export function canClaim(member: Pick<Member, "phone" | "userId">, user: Pick<User, "phone">) {
  return !member.userId && (!member.phone || member.phone === user.phone);
}
