import { describe, expect, it } from "vitest";
import { parseWithRules } from "./rules";
import { buildSpec } from "./spec";
import type { Roster } from "./types";

/**
 * Everyday phrasings, the way people actually type in a group chat, for the three things that
 * change money: adding a bill, changing one and deleting one. Creates are checked down to each
 * person's share; edits and deletes by what they'd change and which bill they point at.
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
const NAME: Record<string, string> = { a: "Arjun", k: "Kabir", r: "Riya", n: "Neha" };
// Monday 19 Oct 2026, 6 pm in India.
const NOW = new Date("2026-10-19T18:00:00+05:30");
const parse = (text: string) => parseWithRules(`@splitbot ${text}`, roster, {}, undefined, NOW);

/** Each person's share in rupees, e.g. { Arjun: 320, Neha: 320 }, plus who paid and the label. */
function bill(text: string) {
  const out = buildSpec(parse(text), roster, {});
  if (out.kind !== "spec") throw new Error(`"${text}" didn't give a split: ${JSON.stringify(out)}`);
  return {
    description: out.spec.description,
    payer: NAME[out.spec.payerId],
    shares: Object.fromEntries(out.result.lines.map((l) => [NAME[l.memberId], l.totalPaise / 100])),
  };
}
const each = (amount: number, ...names: string[]) => Object.fromEntries(names.map((n) => [n, amount]));
const ALL = ["Arjun", "Kabir", "Riya", "Neha"];

describe("adding a bill", () => {
  it.each([
    ["uber 450 split with kabir", "Uber", "Arjun", each(225, "Arjun", "Kabir")],
    ["groceries 1,250 for everyone", "Groceries", "Arjun", each(312.5, ...ALL)],
    ["Neha paid 3000 for the airbnb, split equally", "Airbnb", "Neha", each(750, ...ALL)],
    ["lunch 900 me kabir riya", "Lunch", "Arjun", each(300, "Arjun", "Kabir", "Riya")],
    ["maine 600 diya chai samosa ke liye", "Chai samosa", "Arjun", each(150, ...ALL)],
    ["paid 1200 for movie tickets for me and riya", "Movie tickets", "Arjun", each(600, "Arjun", "Riya")],
    ["kabir and i had coffee for 360", "Coffee", "Arjun", each(180, "Arjun", "Kabir")],
    ["₹2,000 petrol", "Petrol", "Arjun", each(500, ...ALL)],
    ["electricity bill 2340 split 4 ways", "Electricity", "Arjun", each(585, ...ALL)],
    ["pizza 1200 except neha and riya", "Pizza", "Arjun", each(600, "Arjun", "Kabir")],
    ["drinks 1500 only kabir and me", "Drinks", "Arjun", each(750, "Arjun", "Kabir")],
    ["zomato order 640/- with riya", "Zomato order", "Arjun", each(320, "Arjun", "Riya")],
    ["hotel 8k, 2 nights, everyone", "Hotel", "Arjun", each(2000, ...ALL)],
    ["dinner 2400 riya didn't come", "Dinner", "Arjun", each(800, "Arjun", "Kabir", "Neha")],
    ["cab 500 for office", "Cab", "Arjun", each(125, ...ALL)],
    ["lunch 600 with friends", "Lunch", "Arjun", each(150, ...ALL)],
    ["900 for snacks", "Snacks", "Arjun", each(225, ...ALL)],
  ])("%s", (text, description, payer, shares) => {
    expect(bill(text)).toEqual({ description, payer, shares });
  });

  it("asks about a name that isn't in the group instead of splitting among everyone", () => {
    const out = buildSpec(parse("snacks 300 for priya"), roster, {});
    expect(out.kind).toBe("question");
    if (out.kind === "question") expect(out.question.text).toBe(`I don't see "Priya" in this group. Who did you mean?`);
  });

  it("asks how to handle someone not drinking when the drinks aren't listed", () => {
    const out = buildSpec(parse("dinner 1200 riya didn't drink"), roster, {});
    expect(out.kind === "question" && out.question.options.map((o) => o.label)).toEqual(["Leave Riya out", "Split equally anyway"]);
  });
});

describe("changing a bill", () => {
  it.each([
    // [message, what changes, which bill]
    ["actually it was 700", { totalPaise: 70000 }, { ordinal: 1 }],
    ["the dinner was 2200 not 2400", { totalPaise: 220000 }, { keyword: "dinner" }],
    ["change the cab to 700", { totalPaise: 70000 }, { keyword: "cab" }],
    ["make yesterday's dinner 2000", { totalPaise: 200000 }, { keyword: "dinner", day: { from: "2026-10-18" } }],
    ["add riya to the cab", { addParticipants: ["r"] }, { keyword: "cab" }],
    ["remove kabir from yesterday's lunch", { removeParticipants: ["k"] }, { keyword: "lunch", day: { from: "2026-10-18" } }],
    ["riya wasn't there for the dinner", { removeParticipants: ["r"] }, { keyword: "dinner" }],
    ["only me and neha in the cab", { participants: ["a", "n"] }, { keyword: "cab" }],
    ["split the pizza equally", { rule: "equal" }, { keyword: "pizza" }],
    ["make it 60-40 between me and neha", { rule: "percent", percents: [{ member: "a", percent: 60 }, { member: "n", percent: 40 }] }, { ordinal: 1 }],
    ["kabir paid for that, not me", { payer: "k", removeParticipants: [] }, { ordinal: 1 }],
  ])("%s", (text, change, which) => {
    const p = parse(text);
    expect(p.intent).toBe("edit_expense");
    expect(p).toMatchObject(change);
    expect(p.expenseRef).toMatchObject(which);
  });

  it("“make it 60-40” changes the split, not the total", () => {
    expect(parse("make it 60-40 between me and neha").totalPaise).toBeNull();
  });
  it("an edit that doesn't name a bill leaves it to the card or the open proposal", () => {
    expect(parse("actually Kabir paid").expenseRef).toMatchObject({ ordinal: null, keyword: null, day: null });
  });
});

describe("deleting a bill", () => {
  it.each([
    ["oops scrap that", { ordinal: 1, keyword: null }],
    ["wrong entry, remove it", { ordinal: 1, keyword: null }],
    ["can you delete the uber from yesterday", { keyword: "uber", day: { from: "2026-10-18" } }],
    ["cab wala cancel karo", { keyword: "cab" }],
    ["kal ka cab hata do", { keyword: "cab", day: { from: "2026-10-18" } }],
    ["delete the airbnb one", { keyword: "airbnb" }],
    ["delete the bill riya paid on saturday", { payer: "r", day: { from: "2026-10-17" }, keyword: null }],
    ["remove that dinner from last week", { keyword: "dinner", day: { from: "2026-10-12", to: "2026-10-18" } }],
    ["erase the 1,250 groceries", { keyword: "groceries", amountPaise: 125000 }],
    ["delete the one before that", { ordinal: 2 }],
    ["get rid of last saturday's bill", { day: { from: "2026-10-17" }, keyword: null, ordinal: null }],
  ])("%s", (text, which) => {
    const p = parse(text);
    expect(p.intent).toBe("delete_expense");
    expect(p.expenseRef).toMatchObject(which);
  });

  it.each(["delete the bill", "remove the expense", "delete", "delete the thing"])("“%s” is too vague to search", (text) => {
    const p = parse(text);
    expect(p.intent).toBe("delete_expense");
    expect(p.expenseRef!.confidence).toBeLessThan(0.4);
  });

  it("chat filler doesn't become a search word", () => {
    expect(parse("oops scrap that").expenseRef!.keyword).toBeNull();
    expect(parse("arre yaar delete the cab").expenseRef!.keyword).toBe("cab");
  });
});
