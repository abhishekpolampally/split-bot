import { describe, expect, it } from "vitest";
import { parseAmountToPaise } from "@/lib/money";
import { findAmounts, parseWithRules } from "./rules";
import { buildSpec } from "./spec";
import type { Intent, Overrides, Roster } from "./types";

/**
 * Field-level tests for the rule parser: these check the structured intent it
 * produces (who paid, who's in, which rule), not just the final rupee amounts.
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
const everyone = ["a", "k", "r", "n"];

const parse = (text: string, force?: Intent, ov: Overrides = {}, r: Roster = roster) => parseWithRules(text, r, ov, force);

function spec(text: string, ov: Overrides = {}) {
  const out = buildSpec(parse(text, undefined, ov), roster, ov);
  if (out.kind !== "spec") throw new Error(`expected a spec for "${text}", got ${JSON.stringify(out)}`);
  return out;
}
const sharesOf = (text: string, ov: Overrides = {}) =>
  Object.fromEntries(spec(text, ov).result.lines.map((l) => [l.memberId, l.totalPaise]));
const sorted = (ids: string[]) => [...ids].sort();

describe("amounts", () => {
  it.each([
    ["640", 64000],
    ["2,400", 240000],
    ["1,20,000", 12000000],
    ["2.4k", 240000],
    ["1.5l", 15000000],
    ["2 lakh", 20000000],
    ["₹640", 64000],
    ["rs. 99.50", 9950],
    ["rs 99.5", 9950],
    ["640/-", 64000],
  ])("parseAmountToPaise(%s) = %i", (raw, paise) => {
    expect(parseAmountToPaise(raw)).toBe(paise);
  });

  it.each(["0", "abc", "", "-200"])("parseAmountToPaise(%s) is null", (raw) => {
    expect(parseAmountToPaise(raw)).toBeNull();
  });

  it.each([
    ["cab 640", [64000]],
    ["dinner 2,400 and drinks 600", [240000, 60000]],
    ["chai 45.50", [4550]],
    ["beer x3 540", [54000]],
    ["momos 4 pcs 300", [30000]],
    ["villa 5000 kabir 2 shares", [500000]],
    ["petrol 1800 split 3 ways", [180000]],
    ["dinner 1200 for 3 people", [120000]],
    ["gst 18% 90", [9000]],
    ["dinner at 9:30 1200", [120000]],
    ["rs 640 cab", [64000]],
    ["cab 640/-", [64000]],
  ])("findAmounts(%s)", (text, expected) => {
    expect(findAmounts(` ${text} `).map((a) => a.paise)).toEqual(expected);
  });
});

describe("intent", () => {
  it.each<[string, Intent]>([
    ["@splitbot cab 640", "create_expense"],
    ["@splitbot settle", "settle_up"],
    ["@splitbot settle up", "settle_up"],
    ["@splitbot hisaab clear karo", "settle_up"],
    ["@splitbot who owes me?", "query_balance"],
    ["@splitbot what's my balance", "query_balance"],
    ["@splitbot how much does Kabir owe", "query_balance"],
    ["@splitbot how much did we spend on food", "query_spend"],
    ["@splitbot total kharcha", "query_spend"],
    ["@splitbot cancel the cab one", "delete_expense"],
    ["@splitbot delete the last expense", "delete_expense"],
    ["@splitbot actually Kabir paid for that", "edit_expense"],
    ["@splitbot make that 2000", "edit_expense"],
    ["@splitbot hi", "help"],
    ["@splitbot what can you do", "help"],
  ])("%s → %s", (text, intent) => {
    expect(parse(text).intent).toBe(intent);
  });

  it("balance queries pick out the other person", () => {
    expect(parse("@splitbot how much does Kabir owe").queryMember).toBe("k");
    expect(parse("@splitbot who owes me?").queryMember).toBeNull();
  });

  it("spend queries carry a keyword and category", () => {
    const p = parse("@splitbot how much did we spend on food");
    expect(p.queryKeyword).toBe("food");
    expect(p.category).toBe("food");
  });

  it("delete requests carry what to delete", () => {
    expect(parse("@splitbot cancel the cab one").queryKeyword).toBe("cab");
    expect(parse("@splitbot delete the last expense").queryKeyword).toBeNull();
  });
});

describe("payer", () => {
  it("is left to the default (the sender) when nobody is named", () => {
    expect(parse("@splitbot cab 640").payer).toBeNull();
    expect(spec("@splitbot cab 640").spec.payerId).toBe("a");
  });

  it.each([
    ["@splitbot Kabir paid 1200 for lunch", "k"],
    ["@splitbot paid by Neha 900 snacks", "n"],
    ["@splitbot Riya covered the cab 300", "r"],
    ["@splitbot Kabir has paid 800 for movie tickets", "k"],
    ["@splitbot Kabir ne diya 500 petrol", "k"],
    ["@splitbot maine diya 900 chai", "a"],
    ["@splitbot I paid 450 for auto", "a"],
  ])("%s → %s", (text, payer) => {
    expect(parse(text).payer).toBe(payer);
  });

  it("doesn't count the payer's name as a participant", () => {
    const p = parse("@splitbot Kabir paid 1200 for lunch");
    expect(p.participants).not.toContain("k");
    expect(spec("@splitbot Kabir paid 1200 for lunch").result.lines).toHaveLength(4);
  });

  it("flags a payer who isn't in the group", () => {
    const p = parse("@splitbot Rohan paid 900");
    expect(p.payer).toBeNull();
    expect(p.unresolved).toEqual([{ name: "rohan", candidates: [] }]);
  });

  it("flags an ambiguous payer with both candidates", () => {
    const r2: Roster = { senderId: "a", members: [...roster.members.filter((m) => m.id !== "r"), { id: "r1", name: "Riya Shah" }, { id: "r2", name: "Riya Kapoor" }] };
    const p = parse("@splitbot paid by Riya 900", undefined, {}, r2);
    expect(p.payer).toBeNull();
    expect(p.unresolved).toEqual([{ name: "riya", candidates: ["r1", "r2"] }]);
    expect(parse("@splitbot paid by Riya Shah 900", undefined, {}, r2).payer).toBe("r1");
    expect(parse("@splitbot Riya Kapoor paid 900", undefined, {}, r2).payer).toBe("r2");
    expect(parse("@splitbot Riya Kapoor paid 900", undefined, {}, r2).unresolved).toEqual([]);
  });
});

describe("participants", () => {
  it.each([
    ["@splitbot cab 640, me and Neha", ["a", "n"]],
    ["@splitbot cab 640 with Neha", ["a", "n"]],
    ["@splitbot cab 300 Kabir", ["a", "k"]],
    ["@splitbot cab 300 @Kabir", ["a", "k"]],
    ["@splitbot dinner 900 for Riya and Neha", ["r", "n"]],
    ["@splitbot movie 1200, me, Kabir & Riya", ["a", "k", "r"]],
  ])("%s → %j", (text, ids) => {
    expect(sorted(parse(text).participants)).toEqual(sorted(ids));
  });

  it("defaults to the whole group", () => {
    expect(parse("@splitbot petrol 1800").participants).toEqual([]);
    expect(spec("@splitbot petrol 1800").result.lines.map((l) => l.memberId).sort()).toEqual(sorted(everyone));
  });

  it("'everyone' means the whole group", () => {
    expect(sorted(spec("@splitbot lunch 1200 everyone").spec.participants)).toEqual(sorted(everyone));
  });

  it("'except' removes people from the whole bill", () => {
    const p = parse("@splitbot dinner 2.4k everyone except Riya");
    expect(p.excluded).toEqual(["r"]);
    expect(p.totalPaise).toBe(240000);
  });

  it("'except' with several names", () => {
    expect(sorted(parse("@splitbot dinner 2000 except Riya and Neha").excluded)).toEqual(["n", "r"]);
    expect(sharesOf("@splitbot dinner 2000 except Riya and Neha")).toEqual({ a: 100000, k: 100000 });
  });

  it("a head count matching the group size means everyone", () => {
    expect(sorted(parse("@splitbot petrol 1800 split 4 ways").participants)).toEqual(sorted(everyone));
  });

  it.each(["@splitbot petrol 1800 split 3 ways", "@splitbot dinner 1200 for 3 people", "@splitbot pizza 900 me + 2"])(
    "a head count smaller than the group asks who: %s",
    (text) => {
      expect(parse(text).clarify?.kind).toBe("participants");
    },
  );
});

describe("split rules", () => {
  it("equal by default", () => {
    const p = parse("@splitbot cab 640, me and Neha");
    expect(p.rule).toBe("equal");
    expect(p.totalPaise).toBe(64000);
  });

  it("percentages from a ratio", () => {
    const p = parse("@splitbot rent 10000 60-40 between me and Neha");
    expect(p.rule).toBe("percent");
    expect(p.percents).toEqual([
      { member: "a", percent: 60 },
      { member: "n", percent: 40 },
    ]);
  });

  it("three-way ratios", () => {
    const p = parse("@splitbot trip 9000 50-30-20 me, Kabir and Neha");
    expect(p.percents).toEqual([
      { member: "a", percent: 50 },
      { member: "k", percent: 30 },
      { member: "n", percent: 20 },
    ]);
  });

  it("percentages next to names", () => {
    const p = parse("@splitbot rent 30000, me 70% Neha 30%");
    expect(p.rule).toBe("percent");
    expect(sorted(p.percents.map((x) => `${x.member}:${x.percent}`))).toEqual(["a:70", "n:30"]);
  });

  it("a ratio that doesn't add up to 100 isn't a percentage", () => {
    expect(parse("@splitbot rent 10000 60-30 between me and Neha").rule).not.toBe("percent");
  });

  it("a ratio with the wrong number of people asks", () => {
    expect(parse("@splitbot rent 10000 60-40 between me, Kabir and Neha").clarify?.kind).toBe("participants");
  });

  it.each([
    ["@splitbot villa 5000 Kabir 2 shares", "k", 2],
    ["@splitbot villa 5000, 3 shares for Neha", "n", 3],
  ])("shares: %s", (text, member, n) => {
    const p = parse(text);
    expect(p.rule).toBe("shares");
    expect(p.shares).toEqual([{ member, shares: n }]);
  });

  it("exact amount with the rest on the payer", () => {
    const p = parse("@splitbot groceries 1500, Riya 500, rest on me");
    expect(p.rule).toBe("exact");
    expect(p.totalPaise).toBe(150000);
    expect(p.exact).toEqual([{ member: "r", amountPaise: 50000 }]);
    expect(p.remainder).toBe("payer");
  });

  it("exact amount with the rest split equally", () => {
    const p = parse("@splitbot dinner 3000, Riya 1000, rest equally");
    expect(p.exact).toEqual([{ member: "r", amountPaise: 100000 }]);
    expect(p.remainder).toBe("equal");
  });

  it("'baaki main' puts the remainder on the payer", () => {
    expect(parse("@splitbot groceries 1500, Riya 500, baaki main").remainder).toBe("payer");
  });

  it("only exact amounts: the total is their sum", () => {
    const p = parse("@splitbot Riya 500, Kabir 300");
    expect(p.totalPaise).toBe(80000);
    expect(p.exact).toEqual([
      { member: "r", amountPaise: 50000 },
      { member: "k", amountPaise: 30000 },
    ]);
  });

  it("'owes' marks an exact amount", () => {
    expect(parse("@splitbot pizza 1000, Kabir owes 400").exact).toEqual([{ member: "k", amountPaise: 40000 }]);
  });

  it("adjustments on top of an equal split", () => {
    const p = parse("@splitbot drinks 2000, Kabir +200");
    expect(p.rule).toBe("equal");
    expect(p.totalPaise).toBe(200000);
    expect(p.adjustments).toEqual([{ member: "k", amountPaise: 20000 }]);
  });
});

describe("item-wise bills", () => {
  it("lists items and charges separately", () => {
    const p = parse("@splitbot paneer 380, naan 240, gst 31");
    expect(p.rule).toBe("itemwise");
    expect(p.items.map((i) => [i.name, i.qty, i.amountPaise])).toEqual([
      ["Paneer", 1, 38000],
      ["Naan", 1, 24000],
    ]);
    expect(p.charges).toEqual([{ type: "gst", label: "GST", amountPaise: 3100 }]);
    expect(p.totalPaise).toBeNull();
  });

  it.each([
    ["@splitbot butter naan x4 240, dal 280", "Butter naan", 4],
    ["@splitbot 2 plates momos 300, coke 80", "Momos", 2],
  ])("reads quantities: %s", (text, name, qty) => {
    expect(parse(text).items[0]).toMatchObject({ name, qty });
  });

  it("recognises service charge, tip and discounts", () => {
    const p = parse("@splitbot pizza 800, coke 200, service 50, tip 40, discount 100");
    expect(p.charges.map((c) => [c.type, c.amountPaise])).toEqual([
      ["service", 5000],
      ["tip", 4000],
      ["discount", -10000],
    ]);
  });

  it("a discount lowers everyone's share", () => {
    expect(sharesOf("@splitbot pizza 800, coke 200, discount 100")).toEqual({ a: 22500, k: 22500, r: 22500, n: 22500 });
  });

  it("an explicit total is kept for the reconciliation check, not added as an item", () => {
    for (const t of ["@splitbot paneer 380, naan 240, total 620", "@splitbot paneer 380, naan 240, bill 620"]) {
      const p = parse(t);
      expect(p.totalPaise, t).toBe(62000);
      expect(p.items.map((i) => i.name), t).toEqual(["Paneer", "Naan"]);
    }
  });

  it("a total that doesn't match the items is caught", () => {
    const out = buildSpec(parse("@splitbot paneer 380, naan 240, total 900"), roster, {});
    expect(out.kind).toBe("question");
  });

  it("'only X and Y had beer' claims that item", () => {
    const p = parse("@splitbot paneer 380, beer x3 540. only me and Kabir had beer");
    expect(sorted(p.items.find((i) => i.name === "Beer")!.participants)).toEqual(["a", "k"]);
    expect(p.items.find((i) => i.name === "Paneer")!.participants).toEqual([]);
  });

  it("'X didn't have the paneer' excludes them from that item only", () => {
    const p = parse("@splitbot paneer 380, naan 240. Neha didn't have the paneer");
    expect(p.items.find((i) => i.name === "Paneer")!.excluded).toEqual(["n"]);
    expect(p.items.find((i) => i.name === "Naan")!.excluded).toEqual([]);
    expect(p.excluded).toEqual([]);
  });

  it("'X didn't drink' excludes them from the drinks", () => {
    const p = parse("@splitbot pizza 900, beer 600. Riya didn't drink");
    expect(p.items.map((i) => [i.name, i.amountPaise, i.excluded])).toEqual([
      ["Pizza", 90000, []],
      ["Beer", 60000, ["r"]],
    ]);
    expect(p.totalPaise).toBeNull();
    expect(p.clarify).toBeNull();
    expect(sharesOf("@splitbot pizza 900, beer 600. Riya didn't drink")).toEqual({ a: 42500, k: 42500, r: 22500, n: 42500 });
  });

  it("a big first dish isn't mistaken for the bill total", () => {
    const p = parse("@splitbot pizza 900, beer 200. only me and Kabir had beer");
    expect(p.totalPaise).toBeNull();
    expect(p.items.map((i) => i.name)).toEqual(["Pizza", "Beer"]);
  });

  it("'X didn't drink' with no drinks on the bill asks", () => {
    const p = parse("@splitbot dinner 2400, Riya didn't drink");
    expect(p.clarify?.kind).toBe("excluded_drinks");
  });

  it("a total followed by a part of it: 'dinner 2400, drinks 600 except Riya'", () => {
    const p = parse("@splitbot dinner 2400, drinks 600 except Riya");
    expect(p.description).toBe("Dinner");
    expect(p.totalPaise).toBe(240000);
    expect(p.items.map((i) => [i.name, i.amountPaise, i.excluded])).toEqual([
      ["Drinks", 60000, ["r"]],
      ["Everything else", 180000, []],
    ]);
  });
});

describe("description and category", () => {
  it.each([
    ["@splitbot cab 640", "Cab", "travel"],
    ["@splitbot 640 cab", "Cab", "travel"],
    ["@splitbot uber 450", "Uber", "travel"],
    ["@splitbot airbnb 12000", "Airbnb", "stay"],
    ["@splitbot netflix 649", "Netflix", "entertainment"],
    ["@splitbot blinkit 820", "Blinkit", "groceries"],
    ["@splitbot electricity 2100", "Electricity", "utilities"],
    ["@splitbot rent 30000", "Rent", "rent"],
    ["@splitbot beer 900", "Beer", "drinks"],
    ["@splitbot amazon order 1200", "Amazon order", "shopping"],
    ["@splitbot pizza night 1500", "Pizza night", "food"],
    ["@splitbot misc 500", "Misc", "other"],
    ["@splitbot paid by Kabir 900 for snacks", "Snacks", "food"],
  ])("%s → %s (%s)", (text, description, category) => {
    const p = parse(text);
    expect(p.description).toBe(description);
    expect(p.category).toBe(category);
  });

  it("names don't leak into the description", () => {
    expect(parse("@splitbot cab 640, me and Neha").description).toBe("Cab");
    expect(parse("@splitbot Kabir paid 1800 for petrol").description).toBe("Petrol");
  });
});

describe("edits (replying to a card)", () => {
  const edit = (text: string) => parse(text, "edit_expense");

  it("new total", () => {
    expect(edit("@splitbot make that 2000").totalPaise).toBe(200000);
    expect(edit("@splitbot actually it was 1,850").totalPaise).toBe(185000);
  });
  it("new payer", () => {
    expect(edit("@splitbot actually Kabir paid").payer).toBe("k");
    expect(edit("@splitbot paid by Neha").payer).toBe("n");
  });
  it("add and remove people", () => {
    expect(edit("@splitbot add Neha").addParticipants).toEqual(["n"]);
    expect(sorted(edit("@splitbot remove Riya and Kabir").removeParticipants)).toEqual(["k", "r"]);
    expect(edit("@splitbot without Riya").removeParticipants).toEqual(["r"]);
  });
  it("switch to an equal split", () => {
    expect(edit("@splitbot split it equally").rule).toBe("equal");
  });
  it("narrow to just some people", () => {
    expect(sorted(edit("@splitbot only me and Kabir").participants)).toEqual(["a", "k"]);
  });
});

describe("messy input", () => {
  it("is case-insensitive", () => {
    const p = parse("@SplitBot CAB 640, ME AND NEHA");
    expect(p.totalPaise).toBe(64000);
    expect(sorted(p.participants)).toEqual(["a", "n"]);
    expect(p.description).toBe("Cab");
  });

  it("handles newlines and extra spaces", () => {
    const p = parse("@splitbot\ncab    640\nme and neha");
    expect(p.totalPaise).toBe(64000);
    expect(sorted(p.participants)).toEqual(["a", "n"]);
  });

  it("works without the @splitbot tag", () => {
    expect(parse("cab 640, me and Neha").totalPaise).toBe(64000);
  });

  it("reads ₹ and rs prefixes and /- suffixes", () => {
    expect(parse("@splitbot cab ₹640").totalPaise).toBe(64000);
    expect(parse("@splitbot cab rs 640").totalPaise).toBe(64000);
    expect(parse("@splitbot cab 640/-").totalPaise).toBe(64000);
  });

  it("matches full names and ignores names that are only similar", () => {
    const r2: Roster = { senderId: "a", members: [...roster.members, { id: "s", name: "Sam Patel" }] };
    expect(sorted(parse("@splitbot cab 300 me and Sam Patel", undefined, {}, r2).participants)).toEqual(["a", "s"]);
    expect(parse("@splitbot cab 300 me and Nehal").participants).not.toContain("n");
  });

  it("asks which person when a first name is shared", () => {
    const r2: Roster = { senderId: "a", members: [...roster.members, { id: "r2", name: "Riya Kapoor" }] };
    expect(parse("@splitbot cab 300 me and riya", undefined, {}, r2).unresolved).toEqual([{ name: "riya", candidates: ["r", "r2"] }]);
  });

  it("uses a tapped answer for an unknown name", () => {
    const p = parse("@splitbot paid by Kabbir 900", undefined, { nameMap: { kabbir: "k" } });
    expect(p.payer).toBe("k");
    expect(p.unresolved).toEqual([]);
  });

  it("is confident on clean parses and unsure without an amount", () => {
    expect(parse("@splitbot cab 640").confidence).toBe(0.9);
    expect(parse("@splitbot cab for me and Neha", "create_expense").confidence).toBeLessThan(0.5);
  });

  it("splits a small amount down to the paisa", () => {
    expect(sharesOf("@splitbot chai 100, me, Kabir and Riya")).toEqual({ a: 3334, k: 3333, r: 3333 });
  });
});
