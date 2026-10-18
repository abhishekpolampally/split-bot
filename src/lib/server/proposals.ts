import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Member, Proposal } from "@/db/schema";
import { formatINR } from "@/lib/money";
import { computeSplit } from "@/lib/split/engine";
import type { SplitSpec } from "@/lib/split/types";
import { HttpError } from "./http";
import { groupLedger } from "./ledger";
import { botSay, postMessage, touchProposalMessages } from "./messages";
import { notifyGroup } from "./push";

export async function createProposal(opts: {
  groupId: string;
  senderMemberId: string;
  sourceMessageId: number | null;
  spec: SplitSpec;
  flags: string[];
  editsExpenseId?: string | null;
  intro?: string;
}) {
  const result = computeSplit(opts.spec);
  const [p] = await db
    .insert(schema.proposals)
    .values({
      groupId: opts.groupId,
      senderMemberId: opts.senderMemberId,
      sourceMessageId: opts.sourceMessageId,
      spec: opts.spec,
      result,
      flags: opts.flags,
      editsExpenseId: opts.editsExpenseId ?? null,
    })
    .returning();
  await postMessage({
    groupId: opts.groupId,
    kind: "proposal",
    body: `${opts.editsExpenseId ? "Edit" : "Proposed split"}: ${opts.spec.description} · ${formatINR(result.totalPaise)}`,
    proposalId: p.id,
    replyToId: opts.sourceMessageId,
    data: opts.intro ? { intro: opts.intro } : undefined,
  });
  notifyGroup(
    opts.groupId,
    { exceptMemberId: opts.senderMemberId },
    {
      body: `${opts.editsExpenseId ? "Edit proposed" : "New split"}: ${opts.spec.description} · ${formatINR(result.totalPaise)}. Open to check your share.`,
      url: `/g/${opts.groupId}`,
      tag: `chat-${opts.groupId}`,
    },
  );
  return p;
}

async function loadMembers(groupId: string) {
  return db.select().from(schema.members).where(eq(schema.members.groupId, groupId));
}

/**
 * Who may confirm: the payer. If the payer is a placeholder (hasn't joined),
 * the person who asked the bot confirms on their behalf. Nobody can put
 * money on someone else's account without that person's tap.
 */
export function canConfirm(p: Pick<Proposal, "spec" | "senderMemberId">, me: Member, members: Member[]) {
  if (p.spec.payerId === me.id) return true;
  const payer = members.find((m) => m.id === p.spec.payerId);
  return !payer?.userId && p.senderMemberId === me.id;
}

export function canManage(p: Pick<Proposal, "spec" | "senderMemberId">, me: Member) {
  return p.spec.payerId === me.id || p.senderMemberId === me.id;
}

async function lockProposal(id: string, groupId: string) {
  const [p] = await db
    .select()
    .from(schema.proposals)
    .where(and(eq(schema.proposals.id, id), eq(schema.proposals.groupId, groupId)));
  if (!p) throw new HttpError(404, "Proposal not found.");
  return p;
}

export async function confirmProposal(groupId: string, proposalId: string, me: Member, groupName: string) {
  const members = await loadMembers(groupId);
  const expenseId = await db.transaction(async (tx) => {
    const [p] = await tx
      .select()
      .from(schema.proposals)
      .where(and(eq(schema.proposals.id, proposalId), eq(schema.proposals.groupId, groupId)))
      .for("update");
    if (!p) throw new HttpError(404, "Proposal not found.");
    if (p.status !== "proposed") throw new HttpError(409, `This split was already ${p.status}.`);
    if (!canConfirm(p, me, members)) {
      const payer = members.find((m) => m.id === p.spec.payerId);
      throw new HttpError(403, `Only ${payer?.name ?? "the payer"} can confirm this split.`);
    }
    const result = computeSplit(p.spec);
    if (!result.ok) throw new HttpError(400, result.errors.join(" "));

    if (p.editsExpenseId) {
      await tx
        .update(schema.expenses)
        .set({ deletedAt: new Date(), deletedByMemberId: me.id })
        .where(and(eq(schema.expenses.id, p.editsExpenseId), eq(schema.expenses.groupId, groupId)));
    }
    const [expense] = await tx
      .insert(schema.expenses)
      .values({
        groupId,
        description: p.spec.description,
        category: p.spec.category,
        payerMemberId: p.spec.payerId,
        totalPaise: result.totalPaise,
        splitRule: p.spec.rule,
        spec: p.spec,
        proposalId: p.id,
        sourceMessageId: p.sourceMessageId,
        createdByMemberId: p.senderMemberId,
        confirmedByMemberId: me.id,
      })
      .returning();
    const lines = result.lines.filter((l) => l.totalPaise !== 0);
    if (lines.length) {
      await tx.insert(schema.expenseShares).values(
        lines.map((l) => ({ expenseId: expense.id, memberId: l.memberId, amountPaise: l.totalPaise })),
      );
    }
    await tx
      .update(schema.proposals)
      .set({ status: "confirmed", result, expenseId: expense.id, decidedByMemberId: me.id, updatedAt: new Date() })
      .where(eq(schema.proposals.id, p.id));
    await touchProposalMessages(p.id, tx);
    notifyGroup(
      groupId,
      { memberIds: lines.map((l) => l.memberId).filter((m) => m !== me.id) },
      { body: `${me.name} confirmed “${p.spec.description}” (${formatINR(result.totalPaise)}). Balances are updated.`, url: `/g/${groupId}/balances` },
    );
    return expense.id;
  });

  // Post the group's standings, as in the prototype.
  const ledger = await groupLedger(groupId);
  await postMessage({
    groupId,
    kind: "summary",
    body: ledger.transfers.length
      ? `Done. Here's where ${groupName} stands now.`
      : `Done. Everyone in ${groupName} is settled up.`,
    data: { transfers: ledger.transfers, expenseId },
  });
  return expenseId;
}

export async function cancelProposal(groupId: string, proposalId: string, me: Member) {
  const p = await lockProposal(proposalId, groupId);
  if (p.status !== "proposed") throw new HttpError(409, `This split was already ${p.status}.`);
  if (!canManage(p, me)) throw new HttpError(403, "Only the payer or the person who asked can cancel this.");
  await db
    .update(schema.proposals)
    .set({ status: "cancelled", decidedByMemberId: me.id, updatedAt: new Date() })
    .where(and(eq(schema.proposals.id, p.id), eq(schema.proposals.status, "proposed")));
  await touchProposalMessages(p.id);
  await postMessage({ groupId, kind: "system", body: `${me.name} cancelled “${p.spec.description}”. Nothing was added.` });
}

/** Edits from the card: item claims (anyone, for themselves) or a full edit (payer/sender). */
export async function updateProposal(groupId: string, proposalId: string, me: Member, spec: SplitSpec, version: number) {
  const p = await lockProposal(proposalId, groupId);
  if (p.status !== "proposed") throw new HttpError(409, `This split was already ${p.status}.`);
  if (p.version !== version) throw new HttpError(409, "Someone else just changed this split. Refreshing…");

  const members = await loadMembers(groupId);
  const ids = new Set(members.map((m) => m.id));
  const mentioned = [
    spec.payerId,
    ...spec.participants,
    ...Object.keys(spec.exact ?? {}),
    ...Object.keys(spec.percents ?? {}),
    ...Object.keys(spec.shares ?? {}),
    ...Object.keys(spec.adjustments ?? {}),
    ...(spec.items ?? []).flatMap((i) => i.participants),
  ];
  if (mentioned.some((m) => !ids.has(m))) throw new HttpError(400, "Everyone in the split must be in the group.");

  if (!canManage(p, me) && !onlyOwnClaimsChanged(p.spec, spec, me.id)) {
    throw new HttpError(403, "You can only tap your own items. Ask the payer to change the rest.");
  }
  // Changing the payer away from yourself requires the new payer to confirm, which canConfirm enforces.
  const result = computeSplit(spec);
  if (!result.ok) throw new HttpError(400, result.errors.join(" "));

  const updated = await db
    .update(schema.proposals)
    .set({ spec, result, version: sql`${schema.proposals.version} + 1`, updatedAt: new Date() })
    .where(and(eq(schema.proposals.id, p.id), eq(schema.proposals.version, version)))
    .returning({ id: schema.proposals.id });
  if (!updated.length) throw new HttpError(409, "Someone else just changed this split. Refreshing…");
  await touchProposalMessages(p.id);
}

function onlyOwnClaimsChanged(a: SplitSpec, b: SplitSpec, me: string) {
  const strip = (s: SplitSpec) =>
    canonical({ ...s, items: s.items?.map((i) => ({ ...i, participants: i.participants.filter((x) => x !== me).sort() })) });
  return strip(a) === strip(b);
}

/** JSON with sorted keys, so specs compare equal regardless of key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export async function deleteExpense(groupId: string, expenseId: string, me: Member) {
  const [e] = await db
    .select()
    .from(schema.expenses)
    .where(and(eq(schema.expenses.id, expenseId), eq(schema.expenses.groupId, groupId)));
  if (!e || e.deletedAt) throw new HttpError(404, "That expense is already gone.");
  await db
    .update(schema.expenses)
    .set({ deletedAt: new Date(), deletedByMemberId: me.id })
    .where(eq(schema.expenses.id, e.id));
  await botSay(groupId, `${me.name} deleted “${e.description}” (${formatINR(e.totalPaise)}). Balances are updated.`);
}
