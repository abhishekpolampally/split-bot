import type { Category, SplitCharge, SplitRule } from "@/lib/split/types";
import type { DayRange } from "./dates";

export type Intent =
  | "create_expense"
  | "edit_expense"
  | "delete_expense"
  | "query_balance"
  | "query_spend"
  | "settle_up"
  | "help";

export interface RosterMember {
  id: string;
  name: string;
}

export interface Roster {
  members: RosterMember[];
  senderId: string;
}

/**
 * Structured intent extracted from a message (by the LLM or the rule parser).
 * Names are already resolved to member ids. Nothing here is trusted: the
 * orchestrator validates it and the split engine does all the arithmetic.
 */
export interface ParsedMessage {
  intent: Intent;
  description: string | null;
  category: Category | null;
  payer: string | null;
  totalPaise: number | null;
  rule: SplitRule | null;
  /** Empty = default (everyone in the group). */
  participants: string[];
  excluded: string[];
  exact: { member: string; amountPaise: number }[];
  remainder: "equal" | "payer" | null;
  percents: { member: string; percent: number }[];
  shares: { member: string; shares: number }[];
  adjustments: { member: string; amountPaise: number }[];
  items: {
    name: string;
    qty: number;
    amountPaise: number;
    participants: string[];
    excluded: string[];
  }[];
  charges: SplitCharge[];
  /** For edits: members to add to / remove from the split. */
  addParticipants: string[];
  removeParticipants: string[];
  /** For query_spend / delete_expense: what to look for. */
  queryKeyword: string | null;
  queryMember: string | null;
  /** For delete_expense (and edits naming a bill): which logged bill the message means. */
  expenseRef: ExpenseRef | null;
  /** Names that couldn't be matched to a single member. */
  unresolved: { name: string; candidates: string[] }[];
  /** The parser wants to ask something before proposing. */
  clarify: { question: string; kind: "excluded_drinks" | "participants" | "amount" | "other" } | null;
  /** For help / unknown. */
  replyText: string | null;
  /** 0..1, how sure the parser is about the amounts. */
  confidence: number;
}

/**
 * The clues a message gives about an existing bill: "the one before that", "last saturday's
 * dinner", "the 640 cab Kabir paid". Every clue that is set must match.
 */
export interface ExpenseRef {
  /** 1 = the latest match, 2 = the one before it. Null when the message doesn't say. */
  ordinal: number | null;
  /** Words that should appear in the description, items or category ("cab", "dinner"). */
  keyword: string | null;
  amountPaise: number | null;
  /** "Kabir paid", "paid by Kabir". */
  payer: string | null;
  /** A name without "paid" ("Kabir's dinner"): the payer or anyone in the split. */
  member: string | null;
  day: DayRange | null;
  /** "the last two", "both", "the last 3 bills": several bills at once. Only set for 2 or more. */
  count?: number;
  /** 0..1, how precisely the clues pick out a bill. Too low and the bot asks instead of searching. */
  confidence: number;
}

/** Answers collected from clarification taps, applied on top of a parse. */
export interface Overrides {
  payer?: string;
  participants?: string[];
  nameMap?: Record<string, string>;
  excludeWhole?: string[];
  ignoreExclusions?: boolean;
  totalPaise?: number;
  /** delete_expense confirmation. */
  deleteExpenseId?: string;
  /** delete_expense picked a proposal nobody has confirmed yet. */
  cancelProposalId?: string;
  /** edit_expense: the bill picked from a "which one?" question. */
  editBill?: { kind: "expense" | "proposal"; id: string };
  keep?: boolean;
}

export function emptyParse(intent: Intent): ParsedMessage {
  return {
    intent,
    description: null,
    category: null,
    payer: null,
    totalPaise: null,
    rule: null,
    participants: [],
    excluded: [],
    exact: [],
    remainder: null,
    percents: [],
    shares: [],
    adjustments: [],
    items: [],
    charges: [],
    addParticipants: [],
    removeParticipants: [],
    queryKeyword: null,
    queryMember: null,
    expenseRef: null,
    unresolved: [],
    clarify: null,
    replyText: null,
    confidence: 1,
  };
}
