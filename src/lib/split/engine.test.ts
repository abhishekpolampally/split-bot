import { describe, expect, it } from "vitest";
import { computeSplit } from "./engine";
import { simplifyDebts } from "./simplify";
import type { SplitSpec } from "./types";

const base = { description: "x", category: "food" as const, payerId: "a" };
const byMember = (r: ReturnType<typeof computeSplit>) =>
  Object.fromEntries(r.lines.map((l) => [l.memberId, l.totalPaise]));

describe("computeSplit", () => {
  it("reproduces the PRD worked example (Toit dinner)", () => {
    const all = ["a", "k", "r", "n"];
    const spec: SplitSpec = {
      ...base,
      rule: "itemwise",
      totalPaise: 218500,
      participants: all,
      items: [
        { name: "Paneer tikka", qty: 1, amountPaise: 38000, participants: [] },
        { name: "Butter chicken", qty: 1, amountPaise: 46000, participants: [] },
        { name: "Dal makhani", qty: 1, amountPaise: 28000, participants: [] },
        { name: "Butter naan", qty: 4, amountPaise: 24000, participants: [] },
        { name: "Beer", qty: 3, amountPaise: 54000, participants: ["a", "k"] },
      ],
      charges: [
        { type: "gst", label: "GST", amountPaise: 9500 },
        { type: "service", label: "Service", amountPaise: 19000 },
      ],
    };
    const r = computeSplit(spec);
    expect(r.ok).toBe(true);
    expect(byMember(r)).toEqual({ a: 70150, k: 70150, r: 39100, n: 39100 });
  });

  it("splits equally and gives leftover paise to the payer", () => {
    const r = computeSplit({ ...base, rule: "equal", totalPaise: 100000, participants: ["a", "b", "c"] });
    expect(byMember(r)).toEqual({ a: 33334, b: 33333, c: 33333 });
  });

  it("handles exact amounts with the rest on the payer", () => {
    const r = computeSplit({
      ...base,
      rule: "exact",
      totalPaise: 150000,
      participants: ["a", "r"],
      exact: { r: 50000 },
      remainder: "payer",
    });
    expect(byMember(r)).toEqual({ r: 50000, a: 100000 });
  });

  it("handles percentages and rejects ones that don't add to 100", () => {
    const ok = computeSplit({ ...base, rule: "percent", totalPaise: 100000, participants: ["a", "n"], percents: { a: 60, n: 40 } });
    expect(byMember(ok)).toEqual({ a: 60000, n: 40000 });
    const bad = computeSplit({ ...base, rule: "percent", totalPaise: 100000, participants: ["a", "n"], percents: { a: 60, n: 30 } });
    expect(bad.ok).toBe(false);
  });

  it("handles shares and adjustments", () => {
    const r = computeSplit({
      ...base,
      rule: "shares",
      totalPaise: 120000,
      participants: ["a", "k", "r"],
      shares: { k: 2 },
    });
    expect(byMember(r)).toEqual({ a: 30000, k: 60000, r: 30000 });
    const adj = computeSplit({ ...base, rule: "equal", totalPaise: 100000, participants: ["a", "b"], adjustments: { a: 20000 } });
    expect(byMember(adj)).toEqual({ a: 60000, b: 40000 });
  });

  it("flags receipts whose items don't reconcile with the total", () => {
    const r = computeSplit({
      ...base,
      rule: "itemwise",
      totalPaise: 300000,
      participants: ["a", "b"],
      items: [{ name: "x", qty: 1, amountPaise: 100000, participants: [] }],
    });
    expect(r.ok).toBe(false);
  });
});

describe("simplifyDebts", () => {
  it("produces minimal transfers", () => {
    const t = simplifyDebts({ a: 147000, k: -70150, r: -7100, n: -39100, x: -30650 });
    expect(t.reduce((s, x) => s + x.amountPaise, 0)).toBe(147000);
    expect(t.every((x) => x.to === "a")).toBe(true);
  });
});
