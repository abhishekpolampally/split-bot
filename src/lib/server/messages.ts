import "server-only";
import { and, asc, desc, eq, gt, inArray, or } from "drizzle-orm";
import { db, schema, type Tx } from "@/db";
import type { MessageKind, Proposal } from "@/db/schema";

type Executor = typeof db | Tx;

export async function postMessage(
  m: {
    groupId: string;
    kind: MessageKind;
    body: string;
    senderMemberId?: string | null;
    data?: Record<string, unknown>;
    proposalId?: string;
    replyToId?: number | null;
  },
  ex: Executor = db,
) {
  const [row] = await ex
    .insert(schema.messages)
    .values({
      groupId: m.groupId,
      kind: m.kind,
      body: m.body,
      senderMemberId: m.senderMemberId ?? null,
      data: m.data ?? null,
      proposalId: m.proposalId ?? null,
      replyToId: m.replyToId ?? null,
    })
    .returning();
  return row;
}

export const botSay = (groupId: string, body: string, data?: Record<string, unknown>, ex: Executor = db) =>
  postMessage({ groupId, kind: "bot_text", body, data }, ex);

/** Bump updatedAt so polling clients re-fetch the message (e.g. proposal state changed). */
export async function touchMessage(id: number, data?: Record<string, unknown>, ex: Executor = db) {
  await ex
    .update(schema.messages)
    .set({ updatedAt: new Date(), ...(data ? { data } : {}) })
    .where(eq(schema.messages.id, id));
}

export async function touchProposalMessages(proposalId: string, ex: Executor = db) {
  await ex.update(schema.messages).set({ updatedAt: new Date() }).where(eq(schema.messages.proposalId, proposalId));
}

export async function setBotBusy(groupId: string, label: string | null) {
  await db
    .update(schema.groups)
    .set({ botBusyUntil: label ? new Date(Date.now() + 30_000) : null, botBusyLabel: label })
    .where(eq(schema.groups.id, groupId));
}

export type ProposalView = Pick<
  Proposal,
  "id" | "status" | "spec" | "result" | "flags" | "version" | "senderMemberId" | "decidedByMemberId" | "editsExpenseId"
>;

export interface MessageView {
  id: number;
  kind: MessageKind;
  body: string;
  data: Record<string, unknown> | null;
  senderMemberId: string | null;
  replyToId: number | null;
  createdAt: string;
  proposal: ProposalView | null;
}

/** Messages newer than `after`, plus older ones updated since `since`. */
export async function fetchMessages(groupId: string, after: number, since: Date | null, limit = 200) {
  const where = since
    ? and(eq(schema.messages.groupId, groupId), or(gt(schema.messages.id, after), gt(schema.messages.updatedAt, since)))
    : and(eq(schema.messages.groupId, groupId), gt(schema.messages.id, after));

  let rows = await db.select().from(schema.messages).where(where).orderBy(asc(schema.messages.id)).limit(limit + 1);
  const overflow = rows.length > limit;
  // First load: only the most recent `limit` messages.
  if (after === 0 && overflow) {
    rows = (
      await db.select().from(schema.messages).where(eq(schema.messages.groupId, groupId)).orderBy(desc(schema.messages.id)).limit(limit)
    ).reverse();
  }
  // A catch-up bigger than one page: the client's copy is too far behind to patch, so it should
  // drop it and load the latest page instead (`truncated`).
  if (after > 0 && overflow) rows = rows.slice(0, limit);

  const proposalIds = [...new Set(rows.map((r) => r.proposalId).filter(Boolean))] as string[];
  const proposals = proposalIds.length
    ? await db.select().from(schema.proposals).where(inArray(schema.proposals.id, proposalIds))
    : [];
  const byId = new Map(proposals.map((p) => [p.id, p]));

  const views: MessageView[] = rows.map((r) => {
    const p = r.proposalId ? byId.get(r.proposalId) : undefined;
    return {
      id: r.id,
      kind: r.kind,
      body: r.body,
      data: r.data ?? null,
      senderMemberId: r.senderMemberId,
      replyToId: r.replyToId,
      createdAt: r.createdAt.toISOString(),
      proposal: p
        ? {
            id: p.id,
            status: p.status,
            spec: p.spec,
            result: p.result,
            flags: p.flags,
            version: p.version,
            senderMemberId: p.senderMemberId,
            decidedByMemberId: p.decidedByMemberId,
            editsExpenseId: p.editsExpenseId,
          }
        : null,
    };
  });
  const maxUpdated = rows.reduce<Date | null>((m, r) => (!m || r.updatedAt > m ? r.updatedAt : m), since);
  return {
    messages: views,
    maxUpdated,
    truncated: after > 0 && overflow,
    // First load only: whether there's history older than this page.
    hasMore: after === 0 ? overflow : undefined,
  };
}
