import type { Category, SplitSpec } from "@/lib/split/types";
import { istDay } from "./dates";
import { categorise } from "./rules";
import type { ExpenseRef } from "./types";

/**
 * Finding the bill a delete or edit means. The parser turns the message into an ExpenseRef (a
 * query: day, amount, payer, person, keyword, ordinal) with a confidence. Below MIN_REF_CONFIDENCE
 * the bot asks for more detail instead of searching; above it, the database narrows the bills
 * with these clues and `matchBills` ranks what's left.
 */

/** Below this, the request is too vague to search on. */
export const MIN_REF_CONFIDENCE = 0.4;

/** A logged expense, or a proposal still waiting for its tap, that a message might mean. */
export interface BillCandidate {
  kind: "expense" | "proposal";
  id: string;
  spec: SplitSpec;
  createdAt: Date;
}

export const ANY_BILL: ExpenseRef = { ordinal: null, keyword: null, amountPaise: null, payer: null, member: null, day: null, confidence: 1 };

const stem = (w: string) => w.toLowerCase().replace(/'s$/, "").replace(/(es|s)$/, "");

// General words that name a kind of bill, so "the cab" also finds "Uber to airport" when no bill
// says "cab". Specific words ("pizza") must appear on the bill itself.
const GENERAL =
  /^(food|khana|nashta|dinner|lunch|breakfast|brunch|meal|restaurant|drinks?|travel|cab|taxi|uber|ola|rapido|auto|ride|stay|hotel|airbnb|rent|groceries|grocery|shopping|movies?|utilities)$/;

/** Keyword words worth searching for: three letters or more, without plural endings. */
export function keywordStems(keyword: string): string[] {
  return [...new Set(keyword.split(/\s+/).map(stem).filter((k) => k.length >= 3))];
}

/** Categories that the keyword's general words stand for ("cab" → travel). */
export function keywordCategories(keyword: string): Category[] {
  return [...new Set(keyword.split(/\s+/).filter((w) => GENERAL.test(w)).map(categorise))].filter((c) => c !== "other");
}

/** 2 per keyword word written on the bill (description or items), 1 per general word fitting its category. */
function keywordScore(c: BillCandidate, keyword: string): number {
  const words = [c.spec.description, ...(c.spec.items ?? []).map((i) => i.name)]
    .join(" ")
    .toLowerCase()
    .split(/[^\p{L}\d]+/u)
    .filter(Boolean)
    .map(stem);
  let score = 0;
  for (const raw of keyword.split(/\s+/)) {
    const k = stem(raw);
    if (k.length < 3) continue;
    if (words.some((w) => w.length >= 3 && (w.startsWith(k) || k.startsWith(w)))) score += 2;
    else if (GENERAL.test(raw) && categorise(raw) === c.spec.category) score += 1;
  }
  return score;
}

/** Does the reference say anything beyond "the latest one"? */
export function narrows(ref: ExpenseRef) {
  return Boolean(ref.keyword || ref.amountPaise || ref.payer || ref.member || ref.day);
}

/**
 * The bills `ref` could mean, newest first. Every clue that is set must match. With a keyword,
 * only the best-fitting bills stay: if any bill says the word ("Dinner"), ones that merely fit
 * its category ("Paneer and beer") drop out. An ordinal ("the one before that") picks from the rest.
 *
 * The database has already applied these clues roughly (see loadBills); this applies them exactly.
 */
export function matchBills(candidates: BillCandidate[], ref: ExpenseRef): BillCandidate[] {
  let list = [...candidates].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  if (ref.day) {
    const { from, to } = ref.day;
    list = list.filter((c) => {
      const d = istDay(c.createdAt);
      return d >= from && d <= to;
    });
  }
  if (ref.amountPaise) {
    const amt = ref.amountPaise;
    list = list.filter((c) => c.spec.totalPaise === amt || (c.spec.items ?? []).some((i) => i.amountPaise === amt));
  }
  if (ref.payer) list = list.filter((c) => c.spec.payerId === ref.payer);
  if (ref.member) {
    const m = ref.member;
    list = list.filter((c) => c.spec.payerId === m || c.spec.participants.includes(m));
  }
  if (ref.keyword) {
    const scored = list.map((c) => ({ c, score: keywordScore(c, ref.keyword!) }));
    const best = Math.max(0, ...scored.map((s) => s.score));
    list = best ? scored.filter((s) => s.score === best).map((s) => s.c) : [];
  }
  if (ref.ordinal && ref.ordinal > 1) list = list.slice(ref.ordinal - 1, ref.ordinal);
  return list;
}
