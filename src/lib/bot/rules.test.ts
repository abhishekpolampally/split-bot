import { describe, expect, it } from "vitest";
import { parseWithRules } from "./rules";
import { buildSpec } from "./spec";
import type { Overrides, Roster } from "./types";

const roster: Roster = {
  senderId: "a",
  members: [
    { id: "a", name: "Arjun" },
    { id: "k", name: "Kabir" },
    { id: "r", name: "Riya" },
    { id: "n", name: "Neha" },
  ],
};

function run(text: string, ov: Overrides = {}, r: Roster = roster) {
  const parsed = parseWithRules(text, r, ov);
  return { parsed, out: buildSpec(parsed, r, ov) };
}
function shares(text: string, ov: Overrides = {}) {
  const { out } = run(text, ov);
  if (out.kind !== "spec") throw new Error(`expected spec, got ${JSON.stringify(out)}`);
  return Object.fromEntries(out.result.lines.map((l) => [l.memberId, l.totalPaise]));
}

describe("rule parser", () => {
  it("cab 640, me and Neha", () => {
    expect(shares("@splitbot cab 640, me and Neha")).toEqual({ a: 32000, n: 32000 });
    expect(run("@splitbot cab 640, me and Neha").parsed.description).toBe("Cab");
  });

  it("defaults to everyone, equal, payer = sender", () => {
    const { out } = run("@splitbot petrol 1800");
    expect(out.kind).toBe("spec");
    if (out.kind === "spec") {
      expect(out.spec.payerId).toBe("a");
      expect(out.result.lines).toHaveLength(4);
      expect(out.spec.category).toBe("travel");
    }
  });

  it("split 3 ways when the group has 3 → asks who", () => {
    const { out } = run("@splitbot petrol 1800 split 3 ways");
    expect(out.kind).toBe("question");
  });

  it("2.4k shorthand and exclusions", () => {
    expect(shares("@splitbot dinner 2.4k everyone except Riya")).toEqual({ a: 80000, k: 80000, n: 80000 });
  });

  it("someone else paid", () => {
    const { out } = run("@splitbot Kabir paid 1200 for lunch");
    expect(out.kind === "spec" && out.spec.payerId).toBe("k");
  });

  it("percentages", () => {
    expect(shares("@splitbot rent 10000 60-40 between me and Neha")).toEqual({ a: 600000, n: 400000 });
  });

  it("shares", () => {
    expect(shares("@splitbot villa 5000 Kabir 2 shares, others 1")).toEqual({ a: 100000, k: 200000, r: 100000, n: 100000 });
  });

  it("exact with rest on me", () => {
    expect(shares("@splitbot groceries 1500, Riya 500, rest on me")).toEqual({ r: 50000, a: 100000 });
  });

  it("adjustments", () => {
    expect(shares("@splitbot drinks 2000, Kabir +200")).toEqual({ a: 45000, k: 65000, r: 45000, n: 45000 });
  });

  it("itemised with claims and charges (PRD example as text)", () => {
    const s = shares(
      "@splitbot paneer tikka 380, butter chicken 460, dal makhani 280, butter naan x4 240, beer x3 540, gst 95, service 190. only me and Kabir had beer",
    );
    expect(s).toEqual({ a: 70150, k: 70150, r: 39100, n: 39100 });
  });

  it("didn't drink without a drinks amount → asks", () => {
    const { out } = run("@splitbot dinner 2,400, Riya didn't drink, split rest equally");
    expect(out.kind).toBe("question");
    const again = run("@splitbot dinner 2,400, Riya didn't drink, split rest equally", { ignoreExclusions: true });
    expect(again.out.kind).toBe("spec");
  });

  it("drinks part of the total", () => {
    expect(shares("@splitbot dinner 2400, drinks 600 except Riya")).toEqual({ a: 65000, k: 65000, r: 45000, n: 65000 });
  });

  it("unknown name → asks", () => {
    const { out } = run("@splitbot paid by Rohan 900");
    expect(out.kind).toBe("question");
  });

  it("ambiguous first names → asks which", () => {
    const r2: Roster = { senderId: "a", members: [...roster.members, { id: "r2", name: "Riya Shah" }, { id: "r3", name: "Riya Kapoor" }] };
    const { out } = run("@splitbot cab 300 me and riya", {}, r2);
    expect(out.kind).toBe("question");
  });

  it("detects other intents", () => {
    expect(parseWithRules("@splitbot settle", roster).intent).toBe("settle_up");
    expect(parseWithRules("@splitbot who owes me?", roster).intent).toBe("query_balance");
    expect(parseWithRules("@splitbot how much did we spend on food", roster).intent).toBe("query_spend");
    expect(parseWithRules("@splitbot actually Kabir paid for that", roster).intent).toBe("edit_expense");
    expect(parseWithRules("@splitbot make that 2000", roster).totalPaise).toBe(200000);
    expect(parseWithRules("@splitbot cancel the cab one", roster).intent).toBe("delete_expense");
    expect(parseWithRules("@splitbot cancel the cab one", roster).queryKeyword).toBe("cab");
    expect(parseWithRules("@splitbot hi", roster).intent).toBe("help");
  });

  it("hinglish", () => {
    const { out } = run("@splitbot maine 900 diya chai sutta, sab mein barabar");
    expect(out.kind === "spec" && out.result.lines.length).toBe(4);
  });
});

describe("edits", () => {
  it("parses a payer correction when replying to a card", () => {
    const p = parseWithRules("@splitbot Kabir paid", roster, {}, "edit_expense");
    expect(p.payer).toBe("k");
    const q = parseWithRules("@splitbot remove Riya", roster, {}, "edit_expense");
    expect(q.removeParticipants).toEqual(["r"]);
  });
});

describe("descriptions", () => {
  it("names itemised bills sensibly", () => {
    expect(parseWithRules("@splitbot paneer 380, naan 240, gst 31", roster).description).toBe("Restaurant bill");
    expect(parseWithRules("@splitbot dinner 2400, drinks 600 except Riya", roster).description).toBe("Dinner");
  });
});

describe("labels after amounts", () => {
  it("uses trailing words", () => {
    expect(parseWithRules("@splitbot paid by Kabir 900 for snacks", roster).description).toBe("Snacks");
    expect(parseWithRules("@splitbot 640 cab me and Neha", roster).description).toBe("Cab");
  });
});

describe("thousands separators", () => {
  it("keeps 2,400 as one amount", () => {
    expect(shares("@splitbot dinner 2,400, Riya didn't drink, split rest equally", { excludeWhole: ["r"] })).toEqual({ a: 80000, k: 80000, n: 80000 });
    expect(run("@splitbot dinner 2,400, Riya didn't drink").parsed.description).toBe("Dinner");
    expect(shares("@splitbot rent 1,20,000, me and Neha")).toEqual({ a: 6000000, n: 6000000 });
  });
  it("has no amount warning on clean parses and categorises restaurant bills as food", () => {
    const { out } = run("@splitbot cab 640, me and Neha");
    expect(out.kind === "spec" && out.flags).toEqual([]);
    expect(run("@splitbot paneer 380, beer 540").parsed.category).toBe("food");
  });
});

describe("README examples", () => {
  it("all produce a split", () => {
    for (const t of [
      "@splitbot cab 640, me and Neha",
      "@splitbot dinner 2.4k everyone except Riya",
      "@splitbot Kabir paid 1800 for petrol",
      "@splitbot rent 30000 60-40 between me and Neha",
      "@splitbot villa 5000 Kabir 2 shares",
      "@splitbot groceries 1500, Riya 500, rest on me",
      "@splitbot drinks 2000, Kabir +200",
      "@splitbot paneer 380, beer x3 540, gst 46, service 92. only me and Kabir had beer",
      "@splitbot dinner 2400, drinks 600 except Riya",
    ]) {
      const { out } = run(t);
      expect(out.kind, t).toBe("spec");
    }
    expect(shares("@splitbot paneer 380, beer x3 540, gst 46, service 92. only me and Kabir had beer")).toEqual({
      a: 41975, k: 41975, r: 10925, n: 10925,
    });
  });
});
