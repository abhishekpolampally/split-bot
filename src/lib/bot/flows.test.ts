import { readFileSync } from "node:fs";
import path from "node:path";
import { and, desc, eq, gt } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as Db from "@/db";
import type * as Orchestrator from "./orchestrator";
import type * as Proposals from "@/lib/server/proposals";
import type * as Ledger from "@/lib/server/ledger";
import { findDayRange, istDayStart } from "./dates";

vi.mock("server-only", () => ({}));

/**
 * End-to-end bot flows against a real Postgres: a member mentions @splitbot, taps the buttons the
 * bot offers, confirms the card, and the balances come out right. Runs only with
 * TEST_DATABASE_URL set (see `pnpm test:flows`); the database's name must end in "_test",
 * because the suite wipes it and rebuilds the schema from the migrations.
 */

const TEST_URL = process.env.TEST_DATABASE_URL;

let db: typeof Db.db;
let schema: typeof Db.schema;
let bot: typeof Orchestrator;
let proposals: typeof Proposals;
let ledger: typeof Ledger;

async function prepareDatabase(url: string) {
  const name = new URL(url).pathname.slice(1);
  if (!name.endsWith("_test")) throw new Error(`Refusing to wipe "${name}": the test database's name must end in "_test".`);
  const admin = new Client({ connectionString: url.replace(/\/[^/]+$/, "/postgres") });
  await admin.connect();
  const exists = await admin.query("select 1 from pg_database where datname = $1", [name]);
  if (!exists.rowCount) await admin.query(`create database "${name}"`);
  await admin.end();

  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query("drop schema public cascade; create schema public;");
  const dir = path.resolve(import.meta.dirname, "../../../drizzle");
  const journal = JSON.parse(readFileSync(path.join(dir, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
  for (const { tag } of journal.entries) {
    for (const stmt of readFileSync(path.join(dir, `${tag}.sql`), "utf8").split("--> statement-breakpoint")) {
      if (stmt.trim()) await client.query(stmt);
    }
  }
  await client.end();
}

beforeAll(async () => {
  if (!TEST_URL) return;
  await prepareDatabase(TEST_URL);
  process.env.DATABASE_URL = TEST_URL;
  ({ db, schema } = await import("@/db"));
  bot = await import("./orchestrator");
  proposals = await import("@/lib/server/proposals");
  ledger = await import("@/lib/server/ledger");
}, 60_000);

afterAll(async () => {
  await (globalThis as { pgPool?: { end(): Promise<void> } }).pgPool?.end();
});

type Message = typeof Db.schema.messages.$inferSelect;
type Question = { text: string; options: { label: string; patch: Record<string, unknown> }[]; multi?: unknown };

/** A fresh group of Arjun, Kabir, Riya and Neha, and the actions a member can take in its chat. */
async function newGroup() {
  const [group] = await db
    .insert(schema.groups)
    .values({ name: "Goa trip", color: "teal", inviteToken: `t-${Math.random()}` })
    .returning();
  const rows = await db
    .insert(schema.members)
    .values(["Arjun", "Kabir", "Riya", "Neha"].map((name) => ({ groupId: group.id, name, color: "teal" })))
    .returning();
  const [arjun, kabir, riya, neha] = rows;
  const byName = Object.fromEntries(rows.map((m) => [m.name, m]));
  const nameOf = (id: string) => rows.find((m) => m.id === id)!.name;

  /** Everything the bot posted after message `id`. */
  const after = (id: number) =>
    db.select().from(schema.messages).where(and(eq(schema.messages.groupId, group.id), gt(schema.messages.id, id))).orderBy(schema.messages.id);

  /** Arjun (or `as`) mentions the bot; returns the bot's last reply. */
  async function say(text: string, opts: { as?: typeof arjun; replyTo?: number } = {}): Promise<Message> {
    const sender = opts.as ?? arjun;
    const [m] = await db
      .insert(schema.messages)
      .values({ groupId: group.id, senderMemberId: sender.id, kind: "text", body: `@splitbot ${text}`, replyToId: opts.replyTo ?? null })
      .returning();
    await bot.handleMention({ group, sender, text: `@splitbot ${text}`, sourceMessageId: m.id, replyToId: opts.replyTo ?? null });
    const replies = await after(m.id);
    expect(replies.length, `no reply to "${text}"`).toBeGreaterThan(0);
    return replies.at(-1)!;
  }

  const question = (m: Message) => {
    expect(m.kind, `expected a question, got "${m.body}"`).toBe("clarify");
    return (m.data as { question: Question }).question;
  };
  const labels = (m: Message) => question(m).options.map((o) => o.label);

  /** Tap the option whose label starts with `label`; returns the bot's last message after it. */
  async function tap(m: Message, label: string, as = arjun): Promise<Message> {
    const option = question(m).options.find((o) => o.label.startsWith(label));
    expect(option, `no "${label}" in ${JSON.stringify(labels(m))}`).toBeTruthy();
    const [before] = await db.select().from(schema.messages).where(eq(schema.messages.groupId, group.id)).orderBy(desc(schema.messages.id)).limit(1);
    await bot.answerClarification(group, as, m.id, option!.patch as never);
    return (await after(before.id)).at(-1)!;
  }
  /** Tick people on a "who's in" question. */
  async function pick(m: Message, names: string[]): Promise<Message> {
    expect(question(m).multi).toBeTruthy();
    const [before] = await db.select().from(schema.messages).where(eq(schema.messages.groupId, group.id)).orderBy(desc(schema.messages.id)).limit(1);
    await bot.answerClarification(group, arjun, m.id, { participants: names.map((n) => byName[n].id) });
    return (await after(before.id)).at(-1)!;
  }

  const proposalOf = async (m: Message) => {
    expect(m.kind, `expected a split card, got "${m.body}"`).toBe("proposal");
    const [p] = await db.select().from(schema.proposals).where(eq(schema.proposals.id, m.proposalId!));
    return p;
  };
  /** Each person's share on a card, in rupees. */
  const sharesOn = async (m: Message) =>
    Object.fromEntries((await proposalOf(m)).result.lines.filter((l) => l.totalPaise).map((l) => [nameOf(l.memberId), l.totalPaise / 100]));

  /** Confirm the card (as its payer, or Arjun for placeholders) and return the new expense. */
  async function confirm(m: Message, opts: { at?: Date } = {}) {
    const p = await proposalOf(m);
    const expenseId = await proposals.confirmProposal(group.id, p.id, arjun, group.name);
    if (opts.at) await db.update(schema.expenses).set({ createdAt: opts.at }).where(eq(schema.expenses.id, expenseId));
    const [e] = await db.select().from(schema.expenses).where(eq(schema.expenses.id, expenseId));
    return e;
  }
  /** Say it, confirm the card, and optionally backdate it. */
  async function log(text: string, at?: Date) {
    return confirm(await say(text), { at });
  }

  /** Net balance per person in rupees: positive is owed money, negative owes. */
  async function balances() {
    const l = await ledger.groupLedger(group.id);
    return Object.fromEntries(rows.map((m) => [m.name, (l.net[m.id] ?? 0) / 100]));
  }
  const liveBills = async () =>
    (await ledger.groupLedger(group.id)).expenses.map((e) => e.description).sort();
  const latestProposal = async () =>
    (await db.select().from(schema.proposals).where(eq(schema.proposals.groupId, group.id)).orderBy(desc(schema.proposals.createdAt)).limit(1))[0];

  return { group, arjun, kabir, riya, neha, say, tap, pick, labels, question, proposalOf, sharesOn, confirm, log, balances, liveBills, latestProposal };
}

// Days relative to the real clock, in India time, so "yesterday" and "last saturday" line up.
const now = new Date();
const dayOf = (words: string) => findDayRange(` ${words} `, now)!.from;
const at = (day: string, hour: number) => new Date(istDayStart(day).getTime() + hour * 3600_000);

describe.skipIf(!TEST_URL)("adding a bill", () => {
  it("logs a split, and confirming it moves the balances", async () => {
    const g = await newGroup();
    const card = await g.say("cab 640, me and Neha");
    expect(card.body).toBe("Proposed split: Cab · ₹640");
    expect(await g.sharesOn(card)).toEqual({ Arjun: 320, Neha: 320 });
    expect(await g.balances()).toEqual({ Arjun: 0, Kabir: 0, Riya: 0, Neha: 0 });
    await g.confirm(card);
    expect(await g.balances()).toEqual({ Arjun: 320, Kabir: 0, Riya: 0, Neha: -320 });
  });

  it("someone else paid", async () => {
    const g = await newGroup();
    const card = await g.say("Kabir paid 1800 for petrol");
    expect((await g.proposalOf(card)).spec.payerId).toBe(g.kabir.id);
    expect((await g.proposalOf(card)).flags).toContain("payer");
    await g.confirm(card);
    expect(await g.balances()).toEqual({ Arjun: -450, Kabir: 1350, Riya: -450, Neha: -450 });
  });

  it("an item-wise bill with tax", async () => {
    const g = await newGroup();
    const card = await g.say("paneer 380, beer 540 me and Kabir, GST 46");
    expect(await g.sharesOn(card)).toEqual({ Arjun: 383.25, Kabir: 383.25, Riya: 99.75, Neha: 99.75 });
  });

  it("asks who's in a “me+2” split, then uses the people ticked", async () => {
    const g = await newGroup();
    const q = await g.say("me+2 pizza 900");
    expect(g.question(q).text).toBe("Who are the 3 people in this split?");
    const card = await g.pick(q, ["Arjun", "Kabir", "Riya"]);
    expect(await g.sharesOn(card)).toEqual({ Arjun: 300, Kabir: 300, Riya: 300 });
  });

  it("asks about someone not drinking, and leaves them out when told", async () => {
    const g = await newGroup();
    const q = await g.say("dinner 1200 riya didn't drink");
    expect(g.labels(q)).toEqual(["Leave Riya out", "Split equally anyway"]);
    const card = await g.tap(q, "Leave Riya out");
    expect(await g.sharesOn(card)).toEqual({ Arjun: 400, Kabir: 400, Neha: 400 });
  });

  it("asks about a name that isn't in the group; Ignore splits among the rest", async () => {
    const g = await newGroup();
    const q = await g.say("snacks 300 for priya");
    expect(g.question(q).text).toBe(`I don't see "Priya" in this group. Who did you mean?`);
    const card = await g.tap(q, "Ignore");
    expect(await g.sharesOn(card)).toEqual({ Arjun: 75, Kabir: 75, Riya: 75, Neha: 75 });
  });

  it("answering a question by replying in words works too", async () => {
    const g = await newGroup();
    const q = await g.say("me+1 chai 120");
    const card = await g.say("me and riya", { replyTo: q.id });
    expect(await g.sharesOn(card)).toEqual({ Arjun: 60, Riya: 60 });
  });

  it("no amount: explains instead of guessing", async () => {
    const g = await newGroup();
    expect((await g.say("hi")).body).toContain("Mention me with what you paid");
  });
});

describe.skipIf(!TEST_URL)("changing a bill", () => {
  it("corrects the card on screen before anyone confirms", async () => {
    const g = await newGroup();
    const first = await g.say("cab 640 me and neha");
    const card = await g.say("actually make it 700");
    expect(card.body).toBe("Proposed split: Cab · ₹700");
    expect((await g.proposalOf(first)).status).toBe("superseded");
    expect(await g.sharesOn(card)).toEqual({ Arjun: 350, Neha: 350 });
  });

  it("replying to a confirmed card edits that bill, and confirming replaces it", async () => {
    const g = await newGroup();
    const card = await g.say("dinner 2400");
    await g.confirm(card);
    const edit = await g.say("Kabir paid", { replyTo: card.id });
    expect(edit.body).toBe("Edit: Dinner · ₹2,400");
    await g.confirm(edit);
    expect(await g.liveBills()).toEqual(["Dinner"]);
    expect(await g.balances()).toEqual({ Arjun: -600, Kabir: 1800, Riya: -600, Neha: -600 });
  });

  it("“remove Neha from the dinner” changes the dinner, not the newer bill", async () => {
    const g = await newGroup();
    await g.log("dinner 2400", at(dayOf("last saturday"), 21));
    await g.log("chai 120", at(dayOf("yesterday"), 9));
    const edit = await g.say("remove Neha from the dinner");
    expect(edit.body).toBe("Edit: Dinner · ₹2,400");
    expect(await g.sharesOn(edit)).toEqual({ Arjun: 800, Kabir: 800, Riya: 800 });
  });

  it("“the dinner was 2200 not 2400”", async () => {
    const g = await newGroup();
    await g.log("dinner 2400", at(dayOf("yesterday"), 21));
    await g.log("cab 300", at(dayOf("today"), 1));
    const edit = await g.say("the dinner was 2200 not 2400");
    expect(edit.body).toBe("Edit: Dinner · ₹2,200");
  });

  it("“make yesterday's dinner 2000” finds yesterday's, not Saturday's", async () => {
    const g = await newGroup();
    await g.log("dinner 3000", at(dayOf("day before yesterday"), 21));
    await g.log("dinner 2400", at(dayOf("yesterday"), 21));
    await g.log("cab 300", at(dayOf("today"), 1));
    const edit = await g.say("make yesterday's dinner 2000");
    expect(edit.body).toBe("Edit: Dinner · ₹2,000");
    expect((await g.latestProposal()).editsExpenseId).not.toBeNull();
  });

  it("“riya wasn't there for the dinner” and “only me and neha in the cab”", async () => {
    const g = await newGroup();
    await g.log("dinner 2400", at(dayOf("yesterday"), 21));
    await g.log("cab 600", at(dayOf("today"), 1));
    expect(await g.sharesOn(await g.say("riya wasn't there for the dinner"))).toEqual({ Arjun: 800, Kabir: 800, Neha: 800 });
    expect(await g.sharesOn(await g.say("only me and neha in the cab"))).toEqual({ Arjun: 300, Neha: 300 });
  });

  it("“make it 60-40 between me and neha” on the open card", async () => {
    const g = await newGroup();
    await g.say("rent 30000 me and neha");
    const card = await g.say("make it 60-40 between me and neha");
    expect(await g.sharesOn(card)).toEqual({ Arjun: 18000, Neha: 12000 });
  });

  it("“kabir paid for that, not me” changes the payer and keeps Arjun in", async () => {
    const g = await newGroup();
    await g.say("dinner 2400");
    const card = await g.say("kabir paid for that, not me");
    expect((await g.proposalOf(card)).spec.payerId).toBe(g.kabir.id);
    expect(await g.sharesOn(card)).toEqual({ Arjun: 600, Kabir: 600, Riya: 600, Neha: 600 });
  });

  it("several bills fit: asks which, and the tap carries on with the edit", async () => {
    const g = await newGroup();
    await g.log("dinner 2400", at(dayOf("day before yesterday"), 21));
    await g.log("lunch 900", at(dayOf("yesterday"), 13));
    const q = await g.say("remove Neha from the food");
    expect(g.question(q).text).toBe("Which one should I change?");
    expect(g.labels(q)).toHaveLength(3); // two bills and "Never mind"
    const edit = await g.tap(q, "Dinner");
    expect(edit.body).toBe("Edit: Dinner · ₹2,400");
    expect(await g.sharesOn(edit)).toEqual({ Arjun: 800, Kabir: 800, Riya: 800 });
  });

  it("no match: says so and offers the latest bills", async () => {
    const g = await newGroup();
    await g.log("dinner 2400");
    const q = await g.say("change the pizza to 500");
    expect(g.question(q).text).toBe("I couldn't find “pizza”. Which bill should I change?");
    expect(g.labels(q)[0]).toMatch(/^Dinner · ₹2,400 · /);
  });

  it("too vague, with nothing open: asks which bill", async () => {
    const g = await newGroup();
    await g.log("dinner 2400");
    expect((await g.say("actually Kabir paid")).body).toMatch(/^Which bill should I change\?/);
  });
});

describe.skipIf(!TEST_URL)("deleting a bill", () => {
  /** A group with three logged bills: a cab and dinner last Saturday, and an item-wise bill yesterday. */
  async function withBills() {
    const g = await newGroup();
    const sat = dayOf("last saturday");
    const yday = dayOf("yesterday");
    await g.log("cab 640, me and Neha", at(sat, 20));
    await g.log("Kabir paid 2400 for dinner", at(sat, 22));
    await g.log("paneer 380, beer 540 me and Kabir", at(yday, 21));
    return g;
  }

  it("too vague: asks for a detail and doesn't search", async () => {
    const g = await withBills();
    const reply = await g.say("delete the bill");
    expect(reply.kind).toBe("bot_text");
    expect(reply.body).toMatch(/^Which bill should I delete\? Add a detail/);
  });

  it("“remove the previous bill” deletes the latest after a confirm, and balances follow", async () => {
    const g = await withBills();
    const before = await g.balances();
    const q = await g.say("remove the previous bill");
    expect(g.question(q).text).toMatch(/^Delete “Restaurant bill” \(₹920, /);
    const done = await g.tap(q, "Yes, delete it");
    expect(done.body).toBe("Arjun deleted “Restaurant bill” (₹920). Balances are updated.");
    expect(await g.liveBills()).toEqual(["Cab", "Dinner"]);
    expect(await g.balances()).not.toEqual(before);
  });

  it("“let's get rid of last saturday's bill” offers that day's bills", async () => {
    const g = await withBills();
    const q = await g.say("let's get rid of last saturday's bill");
    expect(g.question(q).text).toBe("Which one should I delete?");
    expect(g.labels(q).map((l) => l.split(" · ")[0])).toEqual(["Dinner", "Cab", "Keep everything"]);
    await g.tap(q, "Cab");
    expect(await g.liveBills()).toEqual(["Dinner", "Restaurant bill"]);
  });

  it.each([
    ["delete the 640 cab", "Cab"],
    ["delete the beer", "Restaurant bill"],
    ["delete 380", "Restaurant bill"],
    ["delete the bill kabir paid", "Dinner"],
    ["delete the one before that", "Dinner"],
    ["can you delete the dinner from last saturday", "Dinner"],
    ["kal ka khana hata do", "Restaurant bill"],
  ])("“%s” → %s", async (text, description) => {
    const g = await withBills();
    const q = await g.say(text);
    expect(g.question(q).text).toMatch(new RegExp(`^Delete “${description}”`));
  });

  it("“Keep it” leaves the bill alone", async () => {
    const g = await withBills();
    const reply = await g.tap(await g.say("delete the cab"), "Keep it");
    expect(reply.body).toBe("Okay, leaving it as it is.");
    expect(await g.liveBills()).toEqual(["Cab", "Dinner", "Restaurant bill"]);
  });

  it("no match: says what it looked for and offers the latest three", async () => {
    const g = await withBills();
    const q = await g.say("delete the pizza");
    expect(g.question(q).text).toBe("I couldn't find “pizza”. Did you mean one of these?");
    expect(g.labels(q).map((l) => l.split(" · ")[0])).toEqual(["Restaurant bill", "Dinner", "Cab", "Keep everything"]);
  });

  it("“undo” cancels an unconfirmed card straight away", async () => {
    const g = await withBills();
    const card = await g.say("chai 120 me and riya");
    const reply = await g.say("undo");
    expect(reply.body).toBe("Cancelled “Chai”. Nothing was added.");
    expect((await g.proposalOf(card)).status).toBe("cancelled");
    expect(await g.liveBills()).toEqual(["Cab", "Dinner", "Restaurant bill"]);
  });

  it("a deleted bill can't be found again", async () => {
    const g = await withBills();
    await g.tap(await g.say("delete the cab"), "Yes, delete it");
    const q = await g.say("delete the 640 cab");
    expect(g.question(q).text).toBe("I couldn't find “cab” for ₹640. Did you mean one of these?");
  });

  it("“delete everything” is refused", async () => {
    const g = await withBills();
    expect((await g.say("delete everything")).body).toMatch(/^I can only delete one bill at a time/);
    expect(await g.liveBills()).toHaveLength(3);
  });

  it("“delete the last 2 bills” asks which, one tap per bill, and deletes nothing yet", async () => {
    const g = await withBills();
    for (const text of ["delete the last 2 bills", "delete the last two", "get rid of both"]) {
      const q = await g.say(text);
      expect(g.question(q).text).toBe("I delete one bill at a time, so nothing gets wiped by accident. Here are the last 2. Tap the one to delete, then ask again for the next.");
      expect(g.labels(q).map((l) => l.split(" · ")[0])).toEqual(["Restaurant bill", "Dinner", "Keep everything"]);
    }
    expect(await g.liveBills()).toHaveLength(3);
    await g.tap(await g.say("delete the last 2 bills"), "Dinner");
    expect(await g.liveBills()).toEqual(["Cab", "Restaurant bill"]);
  });

  it("“delete the last 3 cab bills” narrows first and says when there are fewer", async () => {
    const g = await withBills();
    const q = await g.say("delete the last 3 cab bills");
    expect(g.question(q).text).toMatch(/^I delete one bill at a time, so nothing gets wiped by accident\. I only found this one “cab”\./);
    expect(g.labels(q).map((l) => l.split(" · ")[0])).toEqual(["Cab", "Keep everything"]);
  });

  it("spending totals follow deletes", async () => {
    const g = await withBills();
    expect((await g.say("how much did we spend on food")).body).toMatch(/spent ₹3,320 on food across 2 expenses/);
    await g.tap(await g.say("delete the dinner"), "Yes, delete it");
    expect((await g.say("how much did we spend on food")).body).toMatch(/spent ₹920 on food across 1 expense\./);
  });
});
