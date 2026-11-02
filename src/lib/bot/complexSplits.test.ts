import { describe, expect, it } from "vitest";
import { parseWithRules } from "./rules";
import { buildSpec } from "./spec";
import type { Roster } from "./types";

/**
 * Harder splits, phrased the way people describe a real bill: who had what, sums like
 * "390 + 440", "the rest is mine", a shared part plus personal extras. Each case says what
 * should happen: the exact shares, or that the bot asks instead of guessing. A wrong split that
 * looks confident is the worst outcome, because people confirm it without reading.
 *
 * The rule for amounts: a named amount is that person's whole share, and whatever is left of the
 * total is split equally among everyone else in the group, unless the message leaves someone out
 * or says who gets the rest. No total means the amounts are the bill. Naming an item on a bill
 * with a total ("Aman's drinks were 400", "Aman had the beer for 540") is an extra on top of an
 * equal share; "only had" makes it the whole share. The bot asks only when the numbers can't work
 * (the named amounts are more than the total).
 *
 * A case the parser can't handle yet can carry `gap` and run as `it.fails`, so the suite stays
 * green and lists what's missing. When a fix makes it pass, `it.fails` turns red: drop its `gap`.
 */

const roster: Roster = {
  senderId: "a",
  members: [
    { id: "a", name: "Arjun" },
    { id: "m", name: "Aman" },
    { id: "r", name: "Rohan" },
    { id: "n", name: "Neha" },
  ],
};
const NAME: Record<string, string> = { a: "Arjun", m: "Aman", r: "Rohan", n: "Neha" };
const NOW = new Date("2026-11-02T18:00:00+05:30");

/** What the bot would do: propose shares (in rupees, zero shares left out), or ask/reply instead. */
function outcome(text: string) {
  const out = buildSpec(parseWithRules(`@splitbot ${text}`, roster, {}, undefined, NOW), roster, {});
  if (out.kind !== "spec") return { asks: out.kind === "question" ? out.question.text : out.text };
  return {
    payer: NAME[out.spec.payerId],
    total: out.result.totalPaise / 100,
    shares: Object.fromEntries(out.result.lines.filter((l) => l.totalPaise).map((l) => [NAME[l.memberId], l.totalPaise / 100])),
  };
}

type Split = { text: string; shares: Record<string, number>; payer?: string; gap?: string };
/** `mentions`: what the question must say, so the user can see what went wrong. */
type Ask = { text: string; why: string; mentions?: string; gap?: string };

const run = <T extends { text: string; gap?: string }>(cases: T[], check: (c: T) => void) => {
  for (const c of cases) (c.gap ? it.fails : it)(c.gap ? `${c.text}  [gap: ${c.gap}]` : c.text, () => check(c));
};
const expectSplit = ({ text, shares, payer = "Arjun" }: Split) => {
  const total = Object.values(shares).reduce((s, x) => s + x, 0);
  expect(outcome(text)).toEqual({ payer, total, shares });
};
const expectAsk = ({ text, mentions }: Ask) => {
  const o = outcome(text);
  expect(o, `guessed a split instead of asking: ${JSON.stringify(o)}`).toHaveProperty("asks");
  if (mentions) expect((o as { asks: string }).asks).toContain(mentions);
};

// The message from the bug report: me 390 + 440, Aman 350, Rohan 250, which is the ₹1,430 total.
const MINE_830 = { Arjun: 830, Aman: 350, Rohan: 250 };

describe("each person's own amount", () => {
  run<Split>(
    [
      {
        text: "where I had 390 + 440, Aman took something for 350 and rohan took something for 250",
        shares: MINE_830,
      },
      { text: "total is 1430. I had 390 + 440, Aman 350, Rohan 250", shares: MINE_830 },
      { text: "dinner 1430, me 830, aman 350, rohan 250", shares: MINE_830 },
      { text: "dinner 1430: aman 350, rohan 250, rest me", shares: MINE_830 },
      { text: "I paid 1430, Aman's share is 350, Rohan's is 250, the rest is mine", shares: MINE_830 },
      { text: "1430 for dinner. aman had 350, rohan had 250 and I had the rest", shares: MINE_830 },
      {
        text: "Aman owes me 350 and Rohan owes me 250 from the 1430 dinner",
        shares: { Aman: 350, Rohan: 250, Arjun: 415, Neha: 415 },
      },
      { text: "groceries: aman 120+80, rohan 250+100, me 50", shares: { Aman: 200, Rohan: 350, Arjun: 50 } },
      {
        text: "lunch 900, Aman ordered 300 worth and Rohan 200, rest split equally between me and Neha",
        shares: { Aman: 300, Rohan: 200, Arjun: 200, Neha: 200 },
      },
    ],
    expectSplit,
  );
});

describe("the rest is split equally among everyone not named", () => {
  run<Split>(
    [
      { text: "dinner 1430, aman 350, rohan 250", shares: { Aman: 350, Rohan: 250, Arjun: 415, Neha: 415 } },
      { text: "dinner 1430, aman 350, rohan 450", shares: { Aman: 350, Rohan: 450, Arjun: 315, Neha: 315 } },
      { text: "cab 900, Aman 300", shares: { Aman: 300, Arjun: 200, Rohan: 200, Neha: 200 } },
      { text: "dinner 600, aman 350, rohan 250", shares: { Aman: 350, Rohan: 250 } },
      { text: "Aman took something for 350 and rohan took something for 250", shares: { Aman: 350, Rohan: 250 } },
      { text: "dinner 1430, aman 350, rohan 450, neha didn't come", shares: { Aman: 350, Rohan: 450, Arjun: 630 } },
      {
        text: "dinner 1430 except Neha, aman 350",
        shares: { Aman: 350, Arjun: 540, Rohan: 540 },
      },
      { text: "dinner 1430 between me, Aman and Rohan, aman 350", shares: { Aman: 350, Arjun: 540, Rohan: 540 } },
    ],
    expectSplit,
  );
});

describe("a shared part plus personal extras", () => {
  run<Split>(
    [
      {
        text: "dinner 2200 with Aman and Rohan, Aman's drinks were 400 and Rohan's 300, rest split equally",
        shares: { Arjun: 500, Aman: 900, Rohan: 800 },
      },
      {
        text: "bill 1600. Neha only had a coffee for 100, split the rest between me, Aman and Rohan",
        shares: { Neha: 100, Arjun: 500, Aman: 500, Rohan: 500 },
      },
      { text: "snacks 390 + 210 + 300 between me, Aman and Rohan", shares: { Arjun: 300, Aman: 300, Rohan: 300 } },
      { text: "dinner 2000, aman had the beer for 540", shares: { Aman: 905, Arjun: 365, Rohan: 365, Neha: 365 } },
      { text: "aman had 2 beers for 400, dinner 2000", shares: { Aman: 900, Arjun: 500, Rohan: 500, Neha: 500 } },
    ],
    expectSplit,
  );
});

describe("everyday phrasings around these stay right", () => {
  run<Split>(
    [
      { text: "i got 2 pizzas for 600", shares: { Arjun: 150, Aman: 150, Rohan: 150, Neha: 150 } },
      { text: "aman and i had coffee for 360", shares: { Arjun: 180, Aman: 180 } },
      { text: "aman had the beer for 540", shares: { Aman: 540 } },
      { text: "hotel 6000: me 3000, aman 1500, rohan 1500", shares: { Arjun: 3000, Aman: 1500, Rohan: 1500 } },
      { text: "rs. 500 for dinner", shares: { Arjun: 125, Aman: 125, Rohan: 125, Neha: 125 } },
      { text: "drinks 2000, Aman +200", shares: { Arjun: 450, Aman: 650, Rohan: 450, Neha: 450 } },
    ],
    expectSplit,
  );
});

describe("someone else paid", () => {
  run<Split>(
    [{ text: "Aman paid 1430. I had 830, Rohan 250, Aman 350", payer: "Aman", shares: MINE_830 }],
    expectSplit,
  );
});

describe("asks instead of guessing", () => {
  run<Ask>(
    [
      { text: "dinner 500, aman 350, rohan 250", why: "the named amounts (₹600) are more than the total", mentions: "₹600" },
      {
        text: "total 1000, I had 390 + 440, Aman 350, Rohan 250",
        why: "the amounts add up to ₹1,430, not ₹1,000",
        mentions: "₹1,430",
      },
    ],
    expectAsk,
  );
});
