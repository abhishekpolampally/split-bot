import "server-only";
import { and, desc, eq, gt, ilike, isNull, or } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Group, Member } from "@/db/schema";
import { formatINR } from "@/lib/money";
import { groupLedger } from "@/lib/server/ledger";
import { botSay, postMessage, setBotBusy, touchMessage, touchProposalMessages } from "@/lib/server/messages";
import { createProposal, deleteExpense } from "@/lib/server/proposals";
import { computeSplit } from "@/lib/split/engine";
import type { SplitSpec } from "@/lib/split/types";
import { llmEnabled, parseWithLLM } from "./llm";
import { findAmounts, parseWithRules } from "./rules";
import { buildSpec, type Question } from "./spec";
import type { Intent, Overrides, ParsedMessage, Roster } from "./types";

const MAX_QUESTIONS = 2;

export interface MentionInput {
  group: Group;
  sender: Member;
  text: string;
  sourceMessageId: number;
  replyToId?: number | null;
  overrides?: Overrides;
  round?: number;
}

/** Entry point: a message mentioning @splitbot was posted. */
export async function handleMention(input: MentionInput) {
  await setBotBusy(input.group.id, "Reading that…");
  try {
    await run(input);
  } catch (e) {
    console.error("[bot]", e);
    await botSay(
      input.group.id,
      "Sorry, I couldn't process that. Try rephrasing, e.g. “@splitbot cab 640, me and Neha”.",
    );
  } finally {
    await setBotBusy(input.group.id, null);
  }
}

async function run(input: MentionInput) {
  const { group, sender } = input;
  let ov = input.overrides ?? {};
  let round = input.round ?? 0;
  let text = input.text;

  // Replying in words to a question: fold the answer into the original request.
  const replyTo = input.replyToId
    ? (await db.select().from(schema.messages).where(and(eq(schema.messages.id, input.replyToId), eq(schema.messages.groupId, group.id))))[0]
    : undefined;
  if (replyTo?.kind === "clarify") {
    const data = (replyTo.data ?? {}) as { answered?: unknown; pending?: { text: string; overrides: Overrides; round: number } };
    if (!data.answered && data.pending) {
      await touchMessage(replyTo.id, { ...data, answered: { label: `“${text.replace(/@splitbot\b/gi, "").trim()}”`, byMemberId: sender.id } });
      text = `${data.pending.text}\n${text.replace(/@splitbot\b/gi, "")}`;
      ov = data.pending.overrides;
      round = data.pending.round;
      input = { ...input, text };
    }
  }

  const members = await db.select().from(schema.members).where(eq(schema.members.groupId, group.id));
  const roster: Roster = { senderId: sender.id, members: members.map((m) => ({ id: m.id, name: m.name })) };

  const parsed = await parse(text, roster, group.id, ov, replyTo?.kind === "proposal" ? "edit_expense" : undefined);
  // Replying to a card is a correction unless it's clearly something else.
  if (replyTo?.kind === "proposal" && (parsed.intent === "help" || parsed.intent === "create_expense")) {
    parsed.intent = "edit_expense";
  }

  switch (parsed.intent) {
    case "create_expense":
      return createFlow({ ...input, overrides: ov }, parsed, roster, ov, round);
    case "edit_expense":
      return editFlow(input, parsed, members);
    case "delete_expense":
      return deleteFlow(input, parsed);
    case "query_balance":
      return balanceReply(group, sender, members, parsed.queryMember);
    case "query_spend":
      return spendReply(group, sender, parsed);
    case "settle_up":
      return settleReply(group);
    default:
      return botSay(group.id, helpText(parsed.replyText), { help: true });
  }
}

async function parse(text: string, roster: Roster, groupId: string, ov: Overrides, forceIntent?: Intent): Promise<ParsedMessage> {
  if (llmEnabled()) {
    try {
      const recentRows = await db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.groupId, groupId))
        .orderBy(desc(schema.messages.id))
        .limit(10);
      const nameOf = (id: string | null) => roster.members.find((m) => m.id === id)?.name ?? "SplitBot";
      const recent = recentRows.reverse().map((m) => `${nameOf(m.senderMemberId)}: ${m.body.slice(0, 200)}`);
      const pending = await latestPending(groupId);
      const parsed = await parseWithLLM(text, roster, { recent, pending: pending ? summariseSpec(pending.spec) : null }, ov);
      return applyOverrides(guardAmounts(parsed, text), ov);
    } catch (e) {
      console.warn("[bot] LLM failed, falling back to rules:", (e as Error).message);
    }
  }
  return applyOverrides(parseWithRules(text, roster, ov, forceIntent), ov);
}

/** Prompt-injection guard: amounts must trace back to numbers in the sender's own text. */
function guardAmounts(p: ParsedMessage, text: string): ParsedMessage {
  const said = new Set(findAmounts(" " + text.toLowerCase() + " ").map((a) => a.paise));
  const traced = (v: number | null) => v == null || said.has(v);
  const itemsOk = p.items.every((i) => said.has(i.amountPaise));
  if (!traced(p.totalPaise) || !itemsOk || !p.exact.every((e) => said.has(e.amountPaise))) {
    return { ...p, confidence: Math.min(p.confidence, 0.6) };
  }
  return p;
}

function applyOverrides(p: ParsedMessage, ov: Overrides): ParsedMessage {
  const out = { ...p };
  if (ov.ignoreExclusions) {
    out.excluded = [];
    out.items = out.items.map((i) => ({ ...i, excluded: [] }));
    if (out.clarify?.kind === "excluded_drinks") out.clarify = null;
  }
  if (ov.excludeWhole) {
    out.excluded = [...new Set([...out.excluded, ...ov.excludeWhole])];
    if (out.clarify?.kind === "excluded_drinks") out.clarify = null;
  }
  if (ov.participants && out.clarify?.kind === "participants") out.clarify = null;
  return out;
}

async function createFlow(input: MentionInput, parsed: ParsedMessage, roster: Roster, ov: Overrides, round: number) {
  const outcome = buildSpec(parsed, roster, ov, round >= MAX_QUESTIONS);
  if (outcome.kind === "reply") return botSay(input.group.id, outcome.text);
  if (outcome.kind === "question") return ask(input, outcome.question, ov, round);
  await createProposal({
    groupId: input.group.id,
    senderMemberId: input.sender.id,
    sourceMessageId: input.sourceMessageId,
    spec: outcome.spec,
    flags: outcome.flags,
  });
}

async function ask(input: MentionInput, question: Question, ov: Overrides, round: number) {
  await postMessage({
    groupId: input.group.id,
    kind: "clarify",
    body: question.text,
    replyToId: input.sourceMessageId,
    data: {
      question,
      pending: {
        text: input.text,
        senderMemberId: input.sender.id,
        sourceMessageId: input.sourceMessageId,
        overrides: ov,
        round: round + 1,
      },
    },
  });
}

/** A member tapped an option on a clarification message (already claimed by the API). */
export async function answerClarification(group: Group, me: Member, messageId: number, patch: Overrides) {
  const [msg] = await db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.id, messageId), eq(schema.messages.groupId, group.id)));
  if (!msg || msg.kind !== "clarify") throw new Error("Not a question.");
  const data = (msg.data ?? {}) as {
    pending?: { text: string; senderMemberId: string; sourceMessageId: number; overrides: Overrides; round: number };
  };
  if (!data.pending) return { ok: false };

  // Delete confirmation
  if (patch.deleteExpenseId || patch.keep) {
    if (patch.deleteExpenseId) {
      await deleteExpense(group.id, patch.deleteExpenseId, me);
    } else {
      await botSay(group.id, "Okay, leaving it as it is.");
    }
    return { ok: true };
  }

  const [sender] = await db.select().from(schema.members).where(eq(schema.members.id, data.pending.senderMemberId));
  if (!sender) throw new Error("Sender left the group.");
  await handleMention({
    group,
    sender,
    text: data.pending.text,
    sourceMessageId: data.pending.sourceMessageId,
    overrides: { ...data.pending.overrides, ...patch, nameMap: { ...data.pending.overrides.nameMap, ...patch.nameMap } },
    round: data.pending.round,
  });
  return { ok: true };
}

async function latestPending(groupId: string) {
  const [p] = await db
    .select()
    .from(schema.proposals)
    .where(
      and(
        eq(schema.proposals.groupId, groupId),
        eq(schema.proposals.status, "proposed"),
        gt(schema.proposals.createdAt, new Date(Date.now() - 24 * 3600_000)),
      ),
    )
    .orderBy(desc(schema.proposals.createdAt))
    .limit(1);
  return p ?? null;
}

async function editFlow(input: MentionInput, parsed: ParsedMessage, members: Member[]) {
  const { group, sender } = input;
  let base: SplitSpec | null = null;
  let supersede: string | null = null;
  let editsExpenseId: string | null = null;

  // Reply-to a card wins; otherwise the latest pending proposal; otherwise the latest expense.
  if (input.replyToId) {
    const [m] = await db.select().from(schema.messages).where(eq(schema.messages.id, input.replyToId));
    if (m?.proposalId) {
      const [p] = await db.select().from(schema.proposals).where(eq(schema.proposals.id, m.proposalId));
      if (p?.status === "proposed") {
        base = p.spec;
        supersede = p.id;
      } else if (p?.status === "confirmed" && p.expenseId) {
        base = p.spec;
        editsExpenseId = p.expenseId;
      }
    }
  }
  if (!base) {
    const p = await latestPending(group.id);
    if (p) {
      base = p.spec;
      supersede = p.id;
    }
  }
  if (!base) {
    const [e] = await db
      .select()
      .from(schema.expenses)
      .where(and(eq(schema.expenses.groupId, group.id), isNull(schema.expenses.deletedAt)))
      .orderBy(desc(schema.expenses.createdAt))
      .limit(1);
    if (e) {
      base = e.spec;
      editsExpenseId = e.id;
    }
  }
  if (!base) return botSay(group.id, "There's nothing to edit yet. Log an expense first, e.g. “@splitbot cab 640, me and Neha”.");

  const ids = new Set(members.map((m) => m.id));
  const spec: SplitSpec = structuredClone(base);
  if (parsed.payer && ids.has(parsed.payer)) spec.payerId = parsed.payer;
  if (parsed.totalPaise) {
    spec.totalPaise = parsed.totalPaise;
    if (spec.rule === "itemwise") {
      // A new headline total on an itemised bill: fall back to an equal split.
      spec.rule = "equal";
      delete spec.items;
      delete spec.charges;
    }
  }
  if (parsed.rule === "equal") {
    spec.rule = "equal";
    delete spec.exact;
    delete spec.percents;
    delete spec.shares;
  }
  if (parsed.participants.length) spec.participants = parsed.participants.filter((x) => ids.has(x));
  const remove = new Set([...parsed.removeParticipants, ...parsed.excluded]);
  const add = parsed.addParticipants.filter((x) => ids.has(x));
  spec.participants = [...new Set([...spec.participants.filter((x) => !remove.has(x)), ...add])];
  if (spec.items) {
    spec.items = spec.items.map((i) => ({
      ...i,
      participants: (() => {
        const next = i.participants.filter((x) => !remove.has(x));
        return next.length ? next : i.participants;
      })(),
    }));
  }
  for (const r of remove) {
    delete spec.exact?.[r];
    delete spec.percents?.[r];
    delete spec.shares?.[r];
  }

  const result = computeSplit(spec);
  if (!result.ok) return botSay(group.id, `I couldn't apply that edit: ${result.errors.join(" ")}`);
  if (JSON.stringify(spec) === JSON.stringify(base)) {
    return botSay(group.id, "I couldn't tell what to change. Try “@splitbot make that 2000”, “actually Kabir paid” or “remove Riya”.");
  }

  if (supersede) {
    await db
      .update(schema.proposals)
      .set({ status: "superseded", updatedAt: new Date() })
      .where(eq(schema.proposals.id, supersede));
    await touchProposalMessages(supersede);
  }
  const flags = spec.payerId !== sender.id ? ["payer"] : [];
  await createProposal({
    groupId: group.id,
    senderMemberId: sender.id,
    sourceMessageId: input.sourceMessageId,
    spec,
    flags,
    editsExpenseId,
    intro: editsExpenseId ? "Here's the corrected split. Confirming replaces the original." : "Updated split:",
  });
}

async function deleteFlow(input: MentionInput, parsed: ParsedMessage) {
  const { group, sender } = input;
  const kw = parsed.queryKeyword?.trim();

  const pending = await latestPending(group.id);
  if (pending && (!kw || pending.spec.description.toLowerCase().includes(kw.toLowerCase()))) {
    await db
      .update(schema.proposals)
      .set({ status: "cancelled", decidedByMemberId: sender.id, updatedAt: new Date() })
      .where(eq(schema.proposals.id, pending.id));
    await touchProposalMessages(pending.id);
    return postMessage({ groupId: group.id, kind: "system", body: `Cancelled “${pending.spec.description}”. Nothing was added.` });
  }

  const conds = [eq(schema.expenses.groupId, group.id), isNull(schema.expenses.deletedAt)];
  if (kw) conds.push(or(ilike(schema.expenses.description, `%${kw}%`), eq(schema.expenses.category, kw))!);
  const [e] = await db
    .select()
    .from(schema.expenses)
    .where(and(...conds))
    .orderBy(desc(schema.expenses.createdAt))
    .limit(1);
  if (!e) return botSay(group.id, kw ? `I couldn't find an expense matching “${kw}”.` : "There's nothing to cancel.");

  await postMessage({
    groupId: group.id,
    kind: "clarify",
    body: `Delete “${e.description}” (${formatINR(e.totalPaise)})? This changes everyone's balances.`,
    replyToId: input.sourceMessageId,
    data: {
      question: {
        text: `Delete “${e.description}” (${formatINR(e.totalPaise)})?`,
        options: [
          { label: "Yes, delete it", patch: { deleteExpenseId: e.id } },
          { label: "Keep it", patch: { keep: true } },
        ],
      },
      pending: { text: input.text, senderMemberId: sender.id, sourceMessageId: input.sourceMessageId, overrides: {}, round: 1 },
    },
  });
}

async function balanceReply(group: Group, sender: Member, members: Member[], focus: string | null) {
  const ledger = await groupLedger(group.id);
  const name = (id: string) => members.find((m) => m.id === id)?.name ?? "Someone";
  const mine = ledger.transfers.filter((t) => t.from === sender.id || t.to === sender.id);
  const scoped = focus ? mine.filter((t) => t.from === focus || t.to === focus) : mine;
  const net = ledger.net[sender.id] ?? 0;

  if (!ledger.transfers.length) return botSay(group.id, `Everyone in ${group.name} is settled up. 🎉`);
  if (!scoped.length) {
    return botSay(group.id, focus ? `You and ${name(focus)} are square.` : `${sender.name}, you're settled up in ${group.name}.`);
  }
  const lines = scoped.map((t) =>
    t.to === sender.id ? { who: `${name(t.from)} owes ${sender.name}`, amountPaise: t.amountPaise } : { who: `${sender.name} owes ${name(t.to)}`, amountPaise: t.amountPaise },
  );
  const head =
    net > 0 ? `${sender.name} is owed ${formatINR(net)} overall:` : net < 0 ? `${sender.name} owes ${formatINR(-net)} overall:` : `${sender.name} is even overall:`;
  return botSay(group.id, head, { lines, actions: ["balances", "settle"] });
}

async function spendReply(group: Group, sender: Member, parsed: ParsedMessage) {
  const ledger = await groupLedger(group.id);
  const kw = parsed.queryKeyword?.toLowerCase().trim();
  const cat = parsed.category;
  const matches = ledger.expenses.filter((e) =>
    !kw && !cat ? true : (cat && e.category === cat) || (kw ? e.description.toLowerCase().includes(kw) : false),
  );
  const total = matches.reduce((s, e) => s + e.totalPaise, 0);
  const mine = matches.reduce((s, e) => s + (e.shares[sender.id] ?? 0), 0);
  const label = cat ? cat : kw ? `“${kw}”` : "everything";
  if (!matches.length) return botSay(group.id, `Nothing logged for ${label} in ${group.name} yet.`);
  return botSay(group.id, `${group.name} has spent ${formatINR(total)} on ${label} across ${matches.length} expense${matches.length === 1 ? "" : "s"}. ${sender.name}'s share: ${formatINR(mine)}.`, {
    lines: matches.slice(0, 6).map((e) => ({ who: e.description, amountPaise: e.totalPaise })),
  });
}

async function settleReply(group: Group) {
  const ledger = await groupLedger(group.id);
  if (!ledger.transfers.length) return botSay(group.id, `Everyone in ${group.name} is settled up. Nothing to pay.`);
  const n = ledger.transfers.length;
  return postMessage({
    groupId: group.id,
    kind: "settle",
    body: `${n} payment${n === 1 ? "" : "s"} clear${n === 1 ? "s" : ""} every balance in ${group.name}.`,
    data: { transfers: ledger.transfers },
  });
}

function helpText(reply: string | null) {
  return `${reply ? reply + "\n\n" : ""}Mention me with what you paid and I'll propose a split:
• “@splitbot cab 640, me and Neha”
• “@splitbot dinner 2.4k everyone except Riya”
• “@splitbot Kabir paid 1800 for petrol”
• “@splitbot rent 30000 60-40 between me and Neha”
• “@splitbot paneer 380, beer 540 me and Kabir, GST 46”
• “@splitbot who owes me?” · “@splitbot settle”`;
}

function summariseSpec(s: SplitSpec) {
  return `${s.description}, total ${s.totalPaise ?? "items"} paise, payer ${s.payerId}, rule ${s.rule}, participants ${s.participants.join(",")}`;
}
