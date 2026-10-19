import { describe, expect, it } from "vitest";
import type { SplitSpec } from "@/lib/split/types";
import { findDayRange } from "./dates";
import { type BillCandidate, matchBills, MIN_REF_CONFIDENCE } from "./expenseMatch";
import { parseExpenseRef, parseWithRules } from "./rules";
import type { Roster } from "./types";

/**
 * Deleting (and naming) existing bills: which messages are deletes, which clues they carry, and
 * which logged bills those clues pick out.
 */

const roster: Roster = {
  senderId: "a",
  members: [
    { id: "a", name: "Arjun" },
    { id: "k", name: "Kabir" },
    { id: "r", name: "Riya" },
    { id: "n", name: "Neha" },
  ],
};
// Monday 19 Oct 2026, 6 pm in India.
const NOW = new Date("2026-10-19T18:00:00+05:30");
const parse = (text: string) => parseWithRules(text, roster, {}, undefined, NOW);
const ref = (text: string) => parse(text).expenseRef;

describe("delete intent", () => {
  it.each([
    "@splitbot remove the previous bill",
    "@splitbot let's get rid of last saturday's bill",
    "@splitbot delete dinner",
    "@splitbot scrap yesterday's dinner",
    "@splitbot undo",
    "@splitbot remove the 640 cab",
    "@splitbot delete the bill Kabir paid",
    "@splitbot cancel that",
    "@splitbot cancel the cab one",
    "@splitbot delete the last expense",
    "@splitbot delete the one before that",
    "@splitbot kal ka cab hata do",
    "@splitbot please delete 640",
    "@splitbot remove the dinner from 12th oct",
  ])("%s → delete_expense", (text) => {
    expect(parse(text).intent).toBe("delete_expense");
  });

  it.each([
    ["@splitbot remove Neha from the cab", "edit_expense"],
    ["@splitbot drop me from that", "edit_expense"],
    ["@splitbot remove riya", "edit_expense"],
    ["@splitbot cab 640, me and Neha", "create_expense"],
    ["@splitbot dinner 2400 except riya", "create_expense"],
  ])("%s → %s", (text, intent) => {
    expect(parse(text).intent).toBe(intent);
  });
});

describe("which bill a delete means", () => {
  it("“previous” / “that” / “undo” mean the latest, with no other clues", () => {
    for (const t of ["@splitbot remove the previous bill", "@splitbot cancel that", "@splitbot delete the last expense"]) {
      expect(ref(t)).toEqual({ ordinal: 1, keyword: null, amountPaise: null, payer: null, member: null, day: null, confidence: 0.9 });
    }
    expect(ref("@splitbot undo")).toMatchObject({ ordinal: 1, keyword: null });
  });

  it("“the one before that” is the second latest", () => {
    expect(ref("@splitbot delete the one before that")).toMatchObject({ ordinal: 2, keyword: null });
    expect(ref("@splitbot delete the second last one")).toMatchObject({ ordinal: 2, keyword: null });
  });

  it("day words become a date, and “last” in “last saturday” isn't “the latest”", () => {
    expect(ref("@splitbot let's get rid of last saturday's bill")).toMatchObject({
      ordinal: null,
      keyword: null,
      day: { from: "2026-10-17", to: "2026-10-17" },
    });
    expect(ref("@splitbot scrap yesterday's dinner")).toMatchObject({ keyword: "dinner", day: { from: "2026-10-18" } });
    expect(ref("@splitbot kal ka cab hata do")).toMatchObject({ keyword: "cab", day: { from: "2026-10-18" } });
  });

  it("amounts, payers and names", () => {
    expect(ref("@splitbot remove the 640 cab")).toMatchObject({ amountPaise: 64000, keyword: "cab" });
    expect(ref("@splitbot delete the bill Kabir paid")).toMatchObject({ payer: "k", member: null, keyword: null });
    expect(ref("@splitbot delete the dinner paid by riya")).toMatchObject({ payer: "r", keyword: "dinner" });
    expect(ref("@splitbot delete the one I paid")).toMatchObject({ payer: "a", member: null });
    expect(ref("@splitbot delete Kabir's dinner")).toMatchObject({ member: "k", keyword: "dinner" });
  });

  it("keeps the old keyword field for delete requests", () => {
    expect(parse("@splitbot cancel the cab one").queryKeyword).toBe("cab");
  });

  it("edits that name a bill target it; amounts and names are the change, not clues", () => {
    expect(ref("@splitbot remove Neha from the cab")).toMatchObject({ keyword: "cab", amountPaise: null });
    expect(ref("@splitbot make yesterday's dinner 2000")).toMatchObject({ keyword: "dinner", day: { from: "2026-10-18" }, amountPaise: null });
    expect(ref("@splitbot actually Kabir paid for the cab")).toMatchObject({ keyword: "cab", payer: null });
    expect(ref("@splitbot change the cab one to 700")).toMatchObject({ keyword: "cab" });
    // No bill named: "that" means the latest; nothing at all is left to the proposal on screen.
    expect(ref("@splitbot drop me from that")).toMatchObject({ keyword: null, ordinal: 1 });
    expect(ref("@splitbot make it 2000")).toMatchObject({ keyword: null, ordinal: 1 });
    expect(ref("@splitbot remove Neha")).toMatchObject({ keyword: null, ordinal: null, confidence: 0 });
    expect(ref("@splitbot make it equal")).toMatchObject({ keyword: null });
    expect(ref("@splitbot change the payer to Kabir")).toMatchObject({ keyword: null });
  });

  it("works for parsers that only return a keyword", () => {
    expect(parseExpenseRef("@splitbot get rid of last saturday's bill", roster, "delete", NOW)).toMatchObject({ day: { from: "2026-10-17" } });
  });
});

describe("how sure the parser is about which bill", () => {
  const conf = (text: string) => ref(text)!.confidence;
  it.each(["@splitbot delete the bill", "@splitbot delete", "@splitbot remove the expense", "@splitbot delete the thing"])(
    "%s is too vague to search",
    (text) => {
      expect(parse(text).intent).toBe("delete_expense");
      expect(conf(text)).toBeLessThan(MIN_REF_CONFIDENCE);
    },
  );
  it.each([
    "@splitbot delete the last one",
    "@splitbot undo",
    "@splitbot delete yesterday's bill",
    "@splitbot delete the cab",
    "@splitbot delete 640",
    "@splitbot delete the bill Kabir paid",
    "@splitbot delete Kabir's",
  ])("%s is specific enough", (text) => {
    expect(conf(text)).toBeGreaterThanOrEqual(MIN_REF_CONFIDENCE);
  });
  it("more clues, more confidence", () => {
    expect(conf("@splitbot delete yesterday's 640 cab")).toBeGreaterThan(conf("@splitbot delete the cab"));
  });
  it("a long run of words it couldn't place is a sign it didn't understand", () => {
    expect(conf("@splitbot delete whatever happened with goa beach shack")).toBeLessThan(MIN_REF_CONFIDENCE);
  });
});

describe("day words", () => {
  const day = (t: string) => {
    const r = findDayRange(t, NOW);
    return r && [r.from, r.to];
  };
  it.each([
    ["today", ["2026-10-19", "2026-10-19"]],
    ["yesterday", ["2026-10-18", "2026-10-18"]],
    ["the day before yesterday", ["2026-10-17", "2026-10-17"]],
    ["on saturday", ["2026-10-17", "2026-10-17"]],
    ["monday", ["2026-10-19", "2026-10-19"]],
    ["last monday", ["2026-10-12", "2026-10-12"]],
    ["friday's", ["2026-10-16", "2026-10-16"]],
    ["last week", ["2026-10-12", "2026-10-18"]],
    ["this week", ["2026-10-19", "2026-10-19"]],
    ["last month", ["2026-09-01", "2026-09-30"]],
    ["12th oct", ["2026-10-12", "2026-10-12"]],
    ["dec 25", ["2025-12-25", "2025-12-25"]],
  ])("%s", (text, range) => {
    expect(day(` ${text} `)).toEqual(range);
  });
  it("ignores words that only look like days", () => {
    expect(findDayRange(" money for the wedding fries ", NOW)).toBeNull();
  });
  it("uses India's calendar day, not the server's", () => {
    // 11:30 pm UTC on the 18th is already the 19th in India.
    expect(findDayRange(" today ", new Date("2026-10-18T23:30:00Z"))?.from).toBe("2026-10-19");
  });
});

describe("matching bills", () => {
  const bill = (id: string, when: string, spec: Partial<SplitSpec>, kind: BillCandidate["kind"] = "expense"): BillCandidate => ({
    kind,
    id,
    createdAt: new Date(when),
    spec: { description: "Bill", category: "other", payerId: "a", totalPaise: 10000, rule: "equal", participants: ["a", "k", "r", "n"], ...spec },
  });
  const bills = [
    bill("cab-sat", "2026-10-17T21:00:00+05:30", { description: "Cab", category: "travel", totalPaise: 64000, participants: ["a", "n"] }),
    bill("dinner-sat", "2026-10-17T22:00:00+05:30", { description: "Dinner", category: "food", totalPaise: 240000, payerId: "k" }),
    bill("cab-sun", "2026-10-18T10:00:00+05:30", { description: "Uber to airport", category: "travel", totalPaise: 52000 }),
    bill("paneer-sun", "2026-10-18T20:00:00+05:30", {
      description: "Restaurant bill",
      category: "food",
      totalPaise: null,
      rule: "itemwise",
      items: [{ name: "Paneer", qty: 1, amountPaise: 38000, participants: ["a", "k"] }],
    }),
  ];
  const ids = (text: string) => matchBills(bills, ref(text)!).map((b) => b.id);

  it("the latest, and the one before it", () => {
    expect(ids("@splitbot remove the previous bill")[0]).toBe("paneer-sun");
    expect(ids("@splitbot delete the one before that")).toEqual(["cab-sun"]);
  });
  it("by day: everything from last saturday, newest first", () => {
    expect(ids("@splitbot get rid of last saturday's bill")).toEqual(["dinner-sat", "cab-sat"]);
  });
  it("by keyword, matching the description, an item or the category", () => {
    // "Cab" says it; "Uber to airport" only fits the category, so it drops out.
    expect(ids("@splitbot delete the cab")).toEqual(["cab-sat"]);
    // With no bill saying the word, the category decides.
    expect(ids("@splitbot delete the taxi")).toEqual(["cab-sun", "cab-sat"]);
    expect(ids("@splitbot delete the dinner")).toEqual(["dinner-sat"]);
    expect(ids("@splitbot delete the food")).toEqual(["paneer-sun", "dinner-sat"]);
    expect(ids("@splitbot delete the paneer")).toEqual(["paneer-sun"]);
    expect(ids("@splitbot delete saturday's cab")).toEqual(["cab-sat"]);
  });
  it("by amount, payer and person", () => {
    expect(ids("@splitbot remove the 640 cab")).toEqual(["cab-sat"]);
    expect(ids("@splitbot delete 380")).toEqual(["paneer-sun"]);
    expect(ids("@splitbot delete the bill Kabir paid")).toEqual(["dinner-sat"]);
    expect(ids("@splitbot delete Neha's taxi")).toEqual(["cab-sun", "cab-sat"]);
  });
  it("nothing when a clue matches no bill", () => {
    expect(ids("@splitbot delete the pizza")).toEqual([]);
    expect(ids("@splitbot delete today's dinner")).toEqual([]);
  });
});
