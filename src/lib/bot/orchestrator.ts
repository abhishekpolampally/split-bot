import "server-only";
import { and, desc, eq, gt, gte, ilike, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Group, Member } from "@/db/schema";
import { formatINR } from "@/lib/money";
import { groupLedger } from "@/lib/server/ledger";
import { botSay, postMessage, setBotBusy, touchMessage, touchProposalMessages } from "@/lib/server/messages";
import { createProposal, deleteExpense } from "@/lib/server/proposals";
import { computeSplit } from "@/lib/split/engine";
import type { SplitSpec } from "@/lib/split/types";
import { addDays, istDayStart, shortDay } from "./dates";
import { ANY_BILL, type BillCandidate, keywordCategories, keywordStems, matchBills, MIN_REF_CONFIDENCE, narrows } from "./expenseMatch";
import { llmEnabled, parseWithLLM } from "./llm";
import { findAmounts, parseExpenseRef, parseWithRules } from "./rules";
import { buildSpec, type ClarifyOption, type Question } from "./spec";
import type { ExpenseRef, Intent, Overrides, ParsedMessage, Roster } from "./types";

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
      // ";" keeps the answer its own part of the message ("me+1 chai 120; me and riya").
      text = `${data.pending.text}; ${text.replace(/@splitbot\b/gi, "").trim()}`;
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
      return editFlow(input, parsed, members, roster);
    case "delete_expense":
      return deleteFlow(input, parsed, roster);
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
  if (patch.deleteExpenseId || patch.cancelProposalId || patch.keep) {
    if (patch.deleteExpenseId) {
      await deleteExpense(group.id, patch.deleteExpenseId, me);
    } else if (patch.cancelProposalId) {
      await cancelProposal(group.id, patch.cancelProposalId, me);
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

async function editFlow(input: MentionInput, parsed: ParsedMessage, members: Member[], roster: Roster) {
  const { group, sender } = input;
  let base: SplitSpec | null = null;
  let supersede: string | null = null;
  let editsExpenseId: string | null = null;
  const pickBill = (b: BillCandidate) => {
    base = b.spec;
    if (b.kind === "proposal") supersede = b.id;
    else editsExpenseId = b.id;
  };
  // The LLM doesn't say which bill, so read that from the text ourselves.
  const ref = parsed.expenseRef ?? parseExpenseRef(input.text, roster, "edit");

  // Which bill: one picked from a "which one?" question; the card being replied to; a bill the
  // message names ("from yesterday's cab"); the proposal on screen; or "that" = the latest.
  const picked = input.overrides?.editBill;
  if (picked) {
    const bill = await loadBill(group.id, picked);
    if (!bill) return botSay(group.id, "That bill was deleted or already changed.");
    pickBill(bill);
  }
  if (!base && input.replyToId) {
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
  if (!base && (narrows(ref) || (ref.ordinal ?? 0) > 1)) {
    const found = await resolveBill(group.id, ref);
    if (found.kind === "vague") return botSay(group.id, VAGUE_EDIT);
    if (found.kind === "none" || found.kind === "many") {
      const options = (found.kind === "none" ? found.recent : found.bills).map((b) => ({
        label: billLabel(b),
        patch: { editBill: { kind: b.kind, id: b.id } },
      }));
      if (!options.length) return botSay(group.id, `I couldn't find ${describeRef(ref, roster.members)} to change.`);
      return askAboutBills(input, found.kind === "none" ? `I couldn't find ${describeRef(ref, roster.members)}. Which bill should I change?` : "Which one should I change?", options, "Never mind", input.overrides ?? {});
    }
    pickBill(found.bill);
  }
  if (!base) {
    const p = await latestPending(group.id);
    if (p) {
      base = p.spec;
      supersede = p.id;
    }
  }
  if (!base && ref.ordinal === 1) {
    const [latest] = matchBills(await loadBills(group.id, ANY_BILL), ANY_BILL);
    if (latest) pickBill(latest);
    else return botSay(group.id, "There's nothing to edit yet. Log an expense first, e.g. “@splitbot cab 640, me and Neha”.");
  }
  if (!base) return botSay(group.id, VAGUE_EDIT);
  const original: SplitSpec = base;

  const ids = new Set(members.map((m) => m.id));
  const spec: SplitSpec = structuredClone(original);
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
  if (parsed.rule === "percent" && parsed.percents.length) {
    spec.rule = "percent";
    spec.percents = Object.fromEntries(parsed.percents.filter((p) => ids.has(p.member)).map((p) => [p.member, p.percent]));
    spec.participants = Object.keys(spec.percents);
    delete spec.items;
    delete spec.charges;
    delete spec.exact;
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
  if (JSON.stringify(spec) === JSON.stringify(original)) {
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

const VAGUE_DELETE =
  "Which bill should I delete? Add a detail so I can find it, e.g. “@splitbot delete yesterday's cab”, “…the 640 one”, “…the one Kabir paid” or “…the last one”.";
const VAGUE_EDIT =
  "Which bill should I change? Reply to its card, or name it, e.g. “@splitbot remove Neha from yesterday's cab” or “@splitbot make the dinner 2000”.";

const toCandidate = {
  proposal: (p: typeof schema.proposals.$inferSelect): BillCandidate => ({
    kind: "proposal",
    id: p.id,
    spec: { ...p.spec, totalPaise: p.spec.totalPaise ?? p.result.totalPaise },
    createdAt: p.createdAt,
  }),
  expense: (e: typeof schema.expenses.$inferSelect): BillCandidate => ({
    kind: "expense",
    id: e.id,
    spec: { ...e.spec, totalPaise: e.totalPaise },
    createdAt: e.createdAt,
  }),
};

/**
 * Retrieval: the bills that could match `ref`, as open proposals from the last day plus logged
 * expenses. The clues become SQL conditions, so the database returns a handful of rows however
 * long the group's history is (expenses_group_idx covers group + date). The keyword filter here
 * is deliberately loose (any word, anywhere); matchBills does the exact ranking afterwards.
 */
async function loadBills(groupId: string, ref: ExpenseRef): Promise<BillCandidate[]> {
  const e = schema.expenses;
  const conds: (SQL | undefined)[] = [eq(e.groupId, groupId), isNull(e.deletedAt)];
  if (ref.day) conds.push(gte(e.createdAt, istDayStart(ref.day.from)), lt(e.createdAt, istDayStart(addDays(ref.day.to, 1))));
  if (ref.amountPaise) {
    conds.push(or(eq(e.totalPaise, ref.amountPaise), sql`${e.spec}->'items' @> ${JSON.stringify([{ amountPaise: ref.amountPaise }])}::jsonb`));
  }
  if (ref.payer) conds.push(eq(e.payerMemberId, ref.payer));
  if (ref.member) conds.push(or(eq(e.payerMemberId, ref.member), sql`${e.spec}->'participants' ? ${ref.member}`));
  if (ref.keyword) {
    const stems = keywordStems(ref.keyword);
    const cats = keywordCategories(ref.keyword);
    conds.push(
      or(
        ...stems.map((k) => ilike(e.description, `%${k}%`)),
        ...stems.map((k) => sql`exists (select 1 from jsonb_array_elements(coalesce(${e.spec}->'items', '[]'::jsonb)) i where i->>'name' ilike ${`%${k}%`})`),
        cats.length ? inArray(e.category, cats) : undefined,
      ),
    );
  }
  const [proposals, expenses] = await Promise.all([
    db
      .select()
      .from(schema.proposals)
      .where(
        and(
          eq(schema.proposals.groupId, groupId),
          eq(schema.proposals.status, "proposed"),
          gt(schema.proposals.createdAt, new Date(Date.now() - 24 * 3600_000)),
        ),
      ),
    db.select().from(e).where(and(...conds)).orderBy(desc(e.createdAt)).limit(50),
  ]);
  // Open proposals are few (a day's worth), so matchBills filters those in memory.
  return [...proposals.map(toCandidate.proposal), ...expenses.map(toCandidate.expense)];
}

async function loadBill(groupId: string, which: { kind: "expense" | "proposal"; id: string }): Promise<BillCandidate | null> {
  if (which.kind === "proposal") {
    const [p] = await db
      .select()
      .from(schema.proposals)
      .where(and(eq(schema.proposals.id, which.id), eq(schema.proposals.groupId, groupId), eq(schema.proposals.status, "proposed")));
    return p ? toCandidate.proposal(p) : null;
  }
  const [x] = await db
    .select()
    .from(schema.expenses)
    .where(and(eq(schema.expenses.id, which.id), eq(schema.expenses.groupId, groupId), isNull(schema.expenses.deletedAt)));
  return x ? toCandidate.expense(x) : null;
}

type Resolved =
  | { kind: "vague" }
  | { kind: "none"; recent: BillCandidate[] }
  | { kind: "many"; bills: BillCandidate[]; total: number }
  | { kind: "one"; bill: BillCandidate };

/**
 * Decide which bill `ref` means. Too vague → ask for detail without touching the database.
 * Otherwise retrieve and match: one bill, a few to pick from, or none (with the latest few so the
 * person can still pick in a tap).
 */
async function resolveBill(groupId: string, ref: ExpenseRef): Promise<Resolved> {
  if (ref.confidence < MIN_REF_CONFIDENCE) return { kind: "vague" };
  const matches = matchBills(await loadBills(groupId, ref), ref);
  if (!matches.length) {
    const recent = narrows(ref) ? matchBills(await loadBills(groupId, ANY_BILL), ANY_BILL).slice(0, 3) : [];
    return { kind: "none", recent };
  }
  // Several fit and the message didn't say which ("the last cab" would have).
  if (matches.length > 1 && narrows(ref) && !ref.ordinal) return { kind: "many", bills: matches.slice(0, 3), total: matches.length };
  return { kind: "one", bill: matches[0] };
}

async function cancelProposal(groupId: string, proposalId: string, by: Member) {
  const cancelled = await db
    .update(schema.proposals)
    .set({ status: "cancelled", decidedByMemberId: by.id, updatedAt: new Date() })
    .where(and(eq(schema.proposals.id, proposalId), eq(schema.proposals.groupId, groupId), eq(schema.proposals.status, "proposed")))
    .returning();
  if (!cancelled.length) return botSay(groupId, "That split was already confirmed or cancelled.");
  await touchProposalMessages(proposalId);
  await postMessage({ groupId, kind: "system", body: `Cancelled “${cancelled[0].spec.description}”. Nothing was added.` });
}

const billLabel = (b: BillCandidate) =>
  `${b.spec.description} · ${formatINR(b.spec.totalPaise ?? 0)} · ${shortDay(b.createdAt)}${b.kind === "proposal" ? " (not confirmed)" : ""}`;
const deleteOption = (b: BillCandidate): ClarifyOption => ({
  label: billLabel(b),
  patch: b.kind === "proposal" ? { cancelProposalId: b.id } : { deleteExpenseId: b.id },
});

/** "“cab” for ₹640 paid by Kabir from yesterday": what we looked for, said back. */
function describeRef(ref: ExpenseRef, members: Roster["members"]) {
  const name = (id: string) => members.find((m) => m.id === id)?.name ?? "them";
  return [
    ref.keyword ? `“${ref.keyword}”` : "a bill",
    ref.amountPaise ? `for ${formatINR(ref.amountPaise)}` : null,
    ref.payer ? `paid by ${name(ref.payer)}` : null,
    ref.member ? `with ${name(ref.member)}` : null,
    ref.day ? (ref.day.from === ref.day.to && !/^(today|yesterday|the day)/.test(ref.day.label) ? `on ${ref.day.label}` : `from ${ref.day.label}`) : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/** A question with one button per bill, plus a way out. */
function askAboutBills(input: MentionInput, body: string, options: ClarifyOption[], keepLabel: string, overrides: Overrides) {
  return postMessage({
    groupId: input.group.id,
    kind: "clarify",
    body,
    replyToId: input.sourceMessageId,
    data: {
      question: { text: body, options: [...options, { label: keepLabel, patch: { keep: true } }] },
      pending: { text: input.text, senderMemberId: input.sender.id, sourceMessageId: input.sourceMessageId, overrides, round: 1 },
    },
  });
}

/**
 * "Delete the last two": never several at once, since a misread would wipe bills nobody meant.
 * Show the bills it would have been, one button each, so each delete is its own tap.
 */
async function deleteSeveral(input: MentionInput, ref: ExpenseRef, roster: Roster) {
  const { group } = input;
  const bills = matchBills(await loadBills(group.id, ref), ref).slice(0, Math.min(ref.count ?? 2, 5));
  const which = narrows(ref) ? ` ${describeRef(ref, roster.members)}` : "";
  if (!bills.length) {
    return botSay(group.id, narrows(ref) ? `I couldn't find${which}.` : "There's nothing to delete yet.");
  }
  const found =
    bills.length < (ref.count ?? 2)
      ? `I only found ${bills.length === 1 ? "this one" : `these ${bills.length}`}${which}`
      : `Here are the last ${bills.length}${which}`;
  return askAboutBills(
    input,
    `I delete one bill at a time, so nothing gets wiped by accident. ${found}. Tap the one to delete, then ask again for the next.`,
    bills.map(deleteOption),
    "Keep everything",
    {},
  );
}

async function deleteFlow(input: MentionInput, parsed: ParsedMessage, roster: Roster) {
  const { group, sender } = input;
  // The LLM only returns a keyword, so read the other clues from the text ourselves.
  if (/\b(everything|all\s+(?:the\s+|my\s+|our\s+)?(?:bills|expenses|entries))\b/i.test(input.text)) {
    return botSay(group.id, "I can only delete one bill at a time, so nothing gets wiped by accident. Which one? e.g. “@splitbot delete yesterday's cab”.");
  }
  const ref = parsed.expenseRef ?? { ...parseExpenseRef(input.text, roster, "delete"), keyword: parsed.queryKeyword ?? null };
  if (ref.count) return deleteSeveral(input, ref, roster);
  const found = await resolveBill(group.id, ref);

  if (found.kind === "vague") return botSay(group.id, VAGUE_DELETE);
  if (found.kind === "none") {
    if (!narrows(ref)) return botSay(group.id, "There's nothing to delete yet.");
    if (!found.recent.length) return botSay(group.id, `I couldn't find ${describeRef(ref, roster.members)}, and there's nothing logged yet.`);
    return askAboutBills(input, `I couldn't find ${describeRef(ref, roster.members)}. Did you mean one of these?`, found.recent.map(deleteOption), "Keep everything", {});
  }
  if (found.kind === "many") {
    const more = found.total > found.bills.length ? ` Showing the latest ${found.bills.length} of ${found.total}.` : "";
    return askAboutBills(input, `Which one should I delete?${more}`, found.bills.map(deleteOption), "Keep everything", {});
  }

  const bill = found.bill;
  // A proposal nobody confirmed hasn't touched balances, so cancel it straight away.
  if (bill.kind === "proposal") return cancelProposal(group.id, bill.id, sender);
  const total = formatINR(bill.spec.totalPaise ?? 0);
  return askAboutBills(
    input,
    `Delete “${bill.spec.description}” (${total}, ${shortDay(bill.createdAt)})? This changes everyone's balances.`,
    [{ label: "Yes, delete it", patch: { deleteExpenseId: bill.id } }],
    "Keep it",
    {},
  );
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
