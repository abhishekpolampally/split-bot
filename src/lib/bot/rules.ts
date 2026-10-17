import { parseAmountToPaise } from "@/lib/money";
import type { Category, SplitCharge } from "@/lib/split/types";
import { emptyParse, type Intent, type Overrides, type ParsedMessage, type Roster } from "./types";

/**
 * Rule-based parser. Used when no OpenAI key is configured, or as a fallback
 * when the LLM call fails. It covers the common phrasings from the PRD:
 * "cab 640, me and Neha", "dinner 2.4k except Riya", "Kabir paid 1800 split 3 ways",
 * "60-40 between me and Neha", "Riya 500, rest on me", "Kabir 2 shares",
 * "paneer 380, beer 540 me and Kabir, GST 95", "@splitbot settle", "who owes me?".
 */

const SELF = new Set(["me", "i", "myself", "mine", "maine", "mene", "mai", "main", "mujhe", "khud"]);
const ALL = new Set(["everyone", "everybody", "all", "sab", "sabhi", "sabka", "everyones", "us", "we", "group"]);
const STOP = new Set([
  "the", "a", "an", "and", "or", "for", "of", "on", "in", "at", "to", "by", "with", "from", "is", "was",
  "it", "that", "this", "split", "splitting", "equally", "equal", "evenly", "between", "among", "amongst",
  "paid", "pay", "pays", "rest", "rs", "inr", "rupees", "each", "ways", "way", "people", "only", "had",
  "have", "has", "got", "share", "shares", "per", "person", "head", "please", "pls", "plz", "bill",
  "divide", "divided", "among", "add", "log", "karo", "kar", "do", "de", "dena", "baki", "baaki", "barabar",
  "ne", "ka", "ki", "ke", "hai", "tha", "mein", "me", "ko", "just", "also", "too", "total", "hisaab",
]);
const DRINK_WORDS = [
  "beer", "beers", "wine", "drink", "drinks", "alcohol", "cocktail", "cocktails", "whisky", "whiskey",
  "vodka", "rum", "gin", "pint", "pints", "shot", "shots", "booze", "daaru", "daru", "sangria", "mojito",
  "lager", "tequila", "bar",
];
// Segment separators: commas (but not thousands separators like "2,400"), semicolons, newlines, "then".
const SEGMENT_SPLIT = /(?<!\d),|,(?!\d{2})|[;\n]|\bthen\b|\bplus\b/;

const CATEGORY_WORDS: [Category, RegExp][] = [
  ["food", /\b(dinner|lunch|breakfast|brunch|food|pizza|biryani|swiggy|zomato|snacks?|coffee|chai|cafe|restaurant|meal|dessert|cake|paneer|chicken|naan|dal|momos?)\b/],
  ["drinks", /\b(beer|wine|drinks?|bar|pub|cocktails?|daaru|daru|booze)\b/],
  ["travel", /\b(cab|uber|ola|rapido|auto|taxi|petrol|diesel|fuel|toll|flight|train|bus|metro|parking|travel|ride)\b/],
  ["stay", /\b(hotel|airbnb|stay|hostel|room|resort|villa)\b/],
  ["rent", /\b(rent|deposit|brokerage)\b/],
  ["utilities", /\b(electricity|power|wifi|internet|broadband|water|gas|cylinder|maid|cook|bill)\b/],
  ["groceries", /\b(grocer(y|ies)|blinkit|zepto|instamart|bigbasket|vegetables|sabzi|milk|dmart)\b/],
  ["entertainment", /\b(movie|movies|tickets?|concert|netflix|spotify|game|bowling|club|party)\b/],
  ["shopping", /\b(shopping|amazon|flipkart|myntra|gift|clothes)\b/],
];

interface NameHit {
  start: number;
  end: number;
  ids: string[];
  key: string;
  self?: boolean;
  all?: boolean;
}

class Scanner {
  keys = new Map<string, string[]>();
  constructor(
    private roster: Roster,
    private nameMap: Record<string, string> = {},
  ) {
    for (const m of roster.members) {
      const full = m.name.toLowerCase().trim();
      const first = full.split(/\s+/)[0];
      for (const k of new Set([full, first])) {
        if (!k || SELF.has(k)) continue;
        const ids = this.keys.get(k) ?? [];
        if (!ids.includes(m.id)) ids.push(m.id);
        this.keys.set(k, ids);
      }
    }
  }

  /** Find every member mention in `text` (lowercase), longest keys first. */
  scan(text: string): NameHit[] {
    const hits: NameHit[] = [];
    const taken = new Array(text.length).fill(false);
    const keys = [...this.keys.keys(), ...Object.keys(this.nameMap)].sort((a, b) => b.length - a.length);
    for (const key of keys) {
      const re = new RegExp(`(?<![\\p{L}])${escapeRe(key)}(?![\\p{L}])`, "gu");
      for (const m of text.matchAll(re)) {
        const start = m.index!;
        const end = start + key.length;
        if (taken.slice(start, end).some(Boolean)) continue;
        taken.fill(true, start, end);
        const mapped = this.nameMap[key];
        if (mapped === "") continue; // "Ignore" was tapped for this name
        hits.push({ start, end, key, ids: mapped ? [mapped] : (this.keys.get(key) ?? []) });
      }
    }
    for (const m of text.matchAll(/(?<![\p{L}])[\p{L}']+(?![\p{L}])/gu)) {
      const w = m[0];
      const start = m.index!;
      if (taken[start]) continue;
      if (SELF.has(w) && w !== "main" && w !== "mai") {
        hits.push({ start, end: start + w.length, key: w, ids: [this.roster.senderId], self: true });
      } else if (ALL.has(w) && w !== "us" && w !== "we" && w !== "group") {
        hits.push({ start, end: start + w.length, key: w, ids: this.roster.members.map((x) => x.id), all: true });
      }
    }
    return hits.sort((a, b) => a.start - b.start);
  }

  isKnown(word: string) {
    return this.keys.has(word) || word in this.nameMap || SELF.has(word) || ALL.has(word);
  }
}

export function parseWithRules(raw: string, roster: Roster, ov: Overrides = {}, forceIntent?: Intent): ParsedMessage {
  const scanner = new Scanner(roster, ov.nameMap);
  // Work on a lowercase copy; "blank" spans we've consumed so later passes skip them.
  let t = (" " + raw.replace(/@splitbot\b/gi, " ").replace(/\s+/g, " ").trim() + " ").toLowerCase();
  const blank = (start: number, end: number) => {
    t = t.slice(0, start) + " ".repeat(end - start) + t.slice(end);
  };
  const allIds = roster.members.map((m) => m.id);
  const sender = roster.senderId;

  const amountsIn = (s: string) => findAmounts(s);
  const hasAmount = amountsIn(t).length > 0;
  const intent = forceIntent ?? detectIntent(t, hasAmount);
  const out = emptyParse(intent);
  out.confidence = 0.9;

  const unresolved = new Map<string, string[]>();
  const firstIds = (hits: NameHit[]) => {
    const ids: string[] = [];
    for (const h of hits) {
      if (h.ids.length === 1 || h.self || h.all) ids.push(...h.ids);
      else if (h.ids.length > 1) unresolved.set(h.key, h.ids);
    }
    return [...new Set(ids)];
  };
  const namesIn = (s: string) => firstIds(scanner.scan(s));

  // A regex fragment matching a run of names: "riya", "me and neha", "kabir, riya & neha".
  const NAMES = `([\\p{L}']+(?:\\s*(?:,|&|and|aur|\\+)\\s*[\\p{L}']+)*)`;

  // ---- non-expense intents ------------------------------------------------
  if (intent === "settle_up" || intent === "help") return out;

  if (intent === "query_balance") {
    const others = namesIn(t).filter((id) => id !== sender);
    out.queryMember = others[0] ?? null;
    return out;
  }
  if (intent === "query_spend" || intent === "delete_expense") {
    out.queryKeyword = keywordAfter(t, intent === "delete_expense");
    out.queryMember = namesIn(t).find((id) => id !== sender) ?? null;
    if (out.queryKeyword) {
      const cat = categorise(out.queryKeyword);
      if (cat !== "other") out.category = cat;
    }
    return out;
  }

  // ---- payer ---------------------------------------------------------------
  const payerRes = [
    new RegExp(`\\bpaid\\s+by\\s+${NAMES}`, "u"),
    new RegExp(`(?<![\\p{L}])([\\p{L}']+)\\s+(?:has\\s+)?(?:paid|payed|pays|covered|ne\\s+(?:diya|pay\\s+kiya|paid|bhara))(?![\\p{L}])`, "u"),
    /(?<![\p{L}])(maine|mene|humne)\s+(?:diya|pay\s+kiya|bhara|paid)(?![\p{L}])/u,
  ];
  for (const re of payerRes) {
    const m = t.match(re);
    if (!m) continue;
    const word = m[1].trim().split(/\s*(?:,|&|and|aur|\+)\s*/)[0];
    const hits = scanner.scan(word);
    if (hits.length && hits[0].ids.length === 1) out.payer = hits[0].ids[0];
    else if (hits.length && hits[0].ids.length > 1) unresolved.set(word, hits[0].ids);
    else if (["maine", "mene", "humne", "i", "me"].includes(word)) out.payer = sender;
    else if (!(word in (ov.nameMap ?? {})) && !STOP.has(word) && !/^\d/.test(word) && !CATEGORY_WORDS.some(([, r]) => r.test(word)))
      unresolved.set(word, []);
    blank(m.index!, m.index! + m[0].length);
    break;
  }

  // ---- edits ---------------------------------------------------------------
  if (intent === "edit_expense") {
    for (const m of t.matchAll(new RegExp(`\\b(?:add|include|plus|also)\\s+${NAMES}`, "gu"))) {
      out.addParticipants.push(...namesIn(m[1]));
      blank(m.index!, m.index! + m[0].length);
    }
    for (const m of t.matchAll(new RegExp(`\\b(?:remove|exclude|without|drop|minus|except|not)\\s+${NAMES}`, "gu"))) {
      out.removeParticipants.push(...namesIn(m[1]));
      blank(m.index!, m.index! + m[0].length);
    }
    const amts = amountsIn(t);
    if (amts.length) out.totalPaise = amts[amts.length - 1].paise;
    if (/\b(equal|equally|evenly|barabar)\b/.test(t)) out.rule = "equal";
    const only = t.match(new RegExp(`\\bonly\\s+${NAMES}`, "u"));
    if (only) out.participants = namesIn(only[1]);
    finishUnresolved(out, unresolved);
    return out;
  }

  // ---- create: percentages ---------------------------------------------------
  const pctOrder: number[] = [];
  const ratio = t.match(/(?<![\d.])(\d{1,3})\s*[-/:]\s*(\d{1,3})(?:\s*[-/:]\s*(\d{1,3}))?(?![\d%])/);
  if (ratio) {
    const parts = [ratio[1], ratio[2], ratio[3]].filter(Boolean).map(Number);
    if (parts.reduce((a, b) => a + b, 0) === 100) {
      pctOrder.push(...parts);
      blank(ratio.index!, ratio.index! + ratio[0].length);
    }
  }
  for (const m of [...t.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)]) {
    const around = t.slice(Math.max(0, m.index! - 14), m.index! + m[0].length + 14);
    const before = scanner.scan(t.slice(Math.max(0, m.index! - 14), m.index!));
    const after = scanner.scan(t.slice(m.index! + m[0].length, m.index! + m[0].length + 14));
    const hit = before.at(-1) ?? after[0];
    if (hit && hit.ids.length === 1 && !/gst|tax|service|tip|vat/.test(around)) {
      out.percents.push({ member: hit.ids[0], percent: Number(m[1]) });
      const s = before.length ? m.index! - 14 + before.at(-1)!.start : m.index!;
      blank(Math.max(0, s), m.index! + m[0].length);
    } else {
      blank(m.index!, m.index! + m[0].length);
    }
  }

  // ---- shares ----------------------------------------------------------------
  for (const m of [...t.matchAll(new RegExp(`([\\p{L}']+)\\s+(\\d+)\\s*shares?|(\\d+)\\s*shares?\\s+(?:for\\s+)?([\\p{L}']+)`, "gu"))]) {
    const word = m[1] ?? m[4];
    const n = Number(m[2] ?? m[3]);
    const hits = scanner.scan(word);
    if (hits.length && hits[0].ids.length === 1 && !hits[0].all) {
      out.shares.push({ member: hits[0].ids[0], shares: n });
      blank(m.index!, m.index! + m[0].length);
    }
  }
  t = t.replace(/\b(?:others?|rest|everyone else)\s+1\s*(?:shares?)?/g, (s) => " ".repeat(s.length));

  // ---- head counts -----------------------------------------------------------
  let count: number | null = null;
  let countIncludesSelfPlus = false;
  const countRes: [RegExp, boolean][] = [
    [/(?<![\p{L}])(?:me|i)\s*\+\s*(\d{1,2})(?!\d)/u, true],
    [/\b(\d{1,2})\s*(?:ways?|people|persons?|log|members|of us|heads?|jan[ea]?)\b/, false],
    [/\b(?:among|between|amongst|by)\s+(\d{1,2})\b(?!\s*(?:k|,\d|\d))/, false],
  ];
  for (const [re, plus] of countRes) {
    const m = t.match(re);
    if (m) {
      count = Number(m[1]) + (plus ? 1 : 0);
      countIncludesSelfPlus = plus;
      blank(m.index!, m.index! + m[0].length);
      break;
    }
  }

  // ---- adjustments: "arjun +200" -----------------------------------------------
  for (const m of [...t.matchAll(/(?<![\p{L}])([\p{L}']+)\s*\+\s*(?:₹|rs\.?\s*)?(\d[\d,]*(?:\.\d{1,2})?k?)/gu)]) {
    const hits = scanner.scan(m[1]);
    const paise = parseAmountToPaise(m[2]);
    if (hits.length && hits[0].ids.length === 1 && !hits[0].all && paise) {
      out.adjustments.push({ member: hits[0].ids[0], amountPaise: paise });
      blank(m.index!, m.index! + m[0].length);
    }
  }

  // ---- remainder -----------------------------------------------------------------
  const restPayer = t.match(/\brest\s+(?:on|by|paid by|from)\s+(me|i|myself)\b|\bbaaki\s+(?:main|mai|mera)\b/);
  if (restPayer) {
    out.remainder = "payer";
    blank(restPayer.index!, restPayer.index! + restPayer[0].length);
  } else if (/\brest\s+(?:equal|equally|split|divided|evenly)|\bsplit\s+(?:the\s+)?rest\b/.test(t)) {
    out.remainder = "equal";
  }

  // ---- item claims & exclusions ----------------------------------------------------
  const claims: { members: string[]; keyword: string }[] = [];
  const exclusions: { members: string[]; kind: "drink" | "food" | "whole" | "item"; keyword?: string; segment?: boolean }[] = [];
  // Offsets of comma-separated parts, so "drinks 600 except riya" scopes to that item.
  const partAt = (pos: number) => {
    let start = 0;
    for (const piece of t.split(/((?<!\d),|,(?!\d{2})|[;\n])/)) {
      if (pos < start + piece.length) return { start, text: piece };
      start += piece.length;
    }
    return { start: 0, text: t };
  };

  for (const m of [...t.matchAll(new RegExp(`\\b(?:only\\s+)?${NAMES}\\s+(?:had|have|drank|ate|took|shared|ordered|got)\\s+(?:the\\s+|a\\s+|some\\s+)?([\\p{L}]+)`, "gu"))]) {
    const ids = namesIn(m[1]);
    if (!ids.length) continue;
    claims.push({ members: ids, keyword: m[2] });
    blank(m.index!, m.index! + m[0].length);
  }
  for (const m of [...t.matchAll(new RegExp(`\\b(?:except|excluding|without|minus|but not|not including|leave out|leaving out|apart from)\\s+${NAMES}`, "gu"))]) {
    const ids = namesIn(m[1]);
    for (const w of m[1].split(/\s*(?:,|&|and|aur|\+)\s*/)) {
      if (w && !scanner.isKnown(w) && !(w in (ov.nameMap ?? {})) && !STOP.has(w) && /^\p{L}+$/u.test(w)) unresolved.set(w, []);
    }
    if (ids.length) {
      const part = partAt(m.index!);
      const amt = findAmounts(part.text)[0];
      const label = amt ? labelFrom(part.text.slice(0, amt.start), [], scanner).split(" ")[0] : "";
      exclusions.push(label ? { members: ids, kind: "item", keyword: label, segment: true } : { members: ids, kind: "whole" });
    }
    blank(m.index!, m.index! + m[0].length);
  }
  for (const m of [...t.matchAll(new RegExp(`${NAMES}\\s+(?:didn'?t|did not|doesn'?t|does not|don'?t|won'?t|isn'?t|wasn'?t|not|no|skip(?:s|ped)?|skipping|is out of|out of|nahi)\\s*(?:have\\s+|having\\s+|take\\s+|the\\s+|any\\s+)?([\\p{L}]+)?`, "gu"))]) {
    const ids = namesIn(m[1]);
    if (!ids.length) continue;
    const obj = (m[2] ?? "").toLowerCase();
    let kind: "drink" | "food" | "whole" | "item" = "whole";
    if (/^(drink|drinking|drank|drinks|alcohol|booze|daaru|daru|piya|pi)/.test(obj) || DRINK_WORDS.includes(obj)) kind = "drink";
    else if (/^(eat|ate|eating|food|khana|dinner|lunch)/.test(obj)) kind = "food";
    else if (obj && !/^(come|came|join|joined|there|in|part|go|went)/.test(obj)) kind = "item";
    exclusions.push({ members: ids, kind, keyword: kind === "item" ? obj : DRINK_WORDS.includes(obj) ? obj : undefined });
    blank(m.index!, m.index! + m[0].length);
  }

  // ---- amount segments -------------------------------------------------------------
  type Seg = { label: string; paise: number; qty: number; members: string[] };
  const segs: Seg[] = [];
  const exactCandidates: { member: string; paise: number }[] = [];
  let explicitTotal: number | null = null;
  let instructionText = "";

  for (const part of t.split(SEGMENT_SPLIT)) {
    const amts = amountsIn(part);
    if (!amts.length) {
      instructionText += " " + part;
      continue;
    }
    let cursor = 0;
    amts.forEach((a, i) => {
      const before = part.slice(cursor, a.start);
      const after = i === amts.length - 1 ? part.slice(a.end) : "";
      cursor = a.end;
      const qtyM = (before + " " + after).match(/(?:x|×|\*)\s?(\d{1,2})\b|\b(\d{1,2})\s?(?:x|×|pcs|nos|plates?|pieces)\b/);
      const qty = qtyM ? Number(qtyM[1] ?? qtyM[2]) : 1;
      const cleanBefore = before.replace(/(?:x|×|\*)\s?\d{1,2}\b|\b\d{1,2}\s?(?:x|×|pcs|nos|plates?|pieces)\b/g, " ");
      const hits = scanner.scan(cleanBefore + " " + after);
      const members = firstIds(hits);
      let label = labelFrom(cleanBefore, hits.filter((h) => h.start < cleanBefore.length), scanner);
      // "900 for snacks": fall back to the words after the amount.
      if (!label && after.trim()) label = labelFrom(after, scanner.scan(after), scanner);
      const isOwes = /\b(owes|pays|gives|ka|ke|ki)\b/.test(cleanBefore);
      if (/^(sub\s?total|subtotal)$/.test(label)) return;
      if (/^(total|grand total|bill|amount|net|net total|the bill)$/.test(label)) {
        explicitTotal = a.paise;
        if (after.trim()) instructionText += " " + after;
        return;
      }
      // "riya 500" / "500 riya" / "riya owes 500" → an exact amount for that person
      const personOnly = !label && hits.length === 1 && hits[0].ids.length === 1 && !hits[0].all;
      if ((personOnly || (isOwes && members.length === 1)) && !hits[0]?.self) {
        exactCandidates.push({ member: members[0], paise: a.paise });
        return;
      }
      segs.push({ label, paise: a.paise, qty, members });
    });
  }

  const charges: SplitCharge[] = [];
  const items: Seg[] = [];
  for (const s of segs) {
    const type = chargeType(s.label);
    if (type) charges.push({ type, label: chargeLabel(type, s.label), amountPaise: type === "discount" ? -s.paise : s.paise });
    else items.push(s);
  }

  // Instruction-level names (who's in the split).
  const instHits = scanner.scan(instructionText);
  let instMembers = firstIds(instHits);
  const hasSelfWord = instHits.some((h) => h.self) || /\b(we|us)\b/.test(instructionText);
  const hasWith = /\bwith\b|\bsaath\b/.test(instructionText);
  const forOthers = /\b(for|between|among|amongst)\b/.test(instructionText) && !hasSelfWord;
  const everyone = instHits.some((h) => h.all);
  if (everyone) instMembers = allIds;
  else if (instMembers.length && (hasWith || (!forOthers && !hasSelfWord))) {
    instMembers = [...new Set([sender, ...instMembers])];
  }

  // Description.
  let description = items[0]?.label || "";
  if (!description) description = labelFrom(instructionText, instHits, scanner);
  out.description = description ? capitalise(description) : null;
  out.category = categorise(raw.toLowerCase());

  // ---- decide the rule ---------------------------------------------------------------
  let participants = instMembers;
  if (count && !participants.length) {
    if (count === allIds.length) participants = allIds;
    else if (countIncludesSelfPlus || count) out.clarify = { question: `Who are the ${count} people in this split?`, kind: "participants" };
  }

  if (items.length === 1 && charges.length === 0) {
    out.totalPaise = items[0].paise;
    if (items[0].members.length && !participants.length) {
      // "cab 640 riya" → me + Riya; "dinner 900 for riya and neha" → just them.
      const segFor = /\b(for|between|among|amongst)\b/.test(t) && !items[0].members.includes(sender);
      participants = segFor ? items[0].members : [...new Set([sender, ...items[0].members])];
    }
  } else if (items.length + charges.length > 0) {
    // Several amounts: "dinner 2400, drinks 600 except riya" — if the first is bigger than the
    // rest put together, treat it as the total and the rest as parts of it.
    const rest = items.slice(1).reduce((s, i) => s + i.paise, 0) + charges.reduce((s, c) => s + c.amountPaise, 0);
    const firstIsTotal = explicitTotal == null && items.length >= 2 && items[0].paise > rest && exclusions.length + claims.length > 0;
    if (firstIsTotal) {
      explicitTotal = items[0].paise;
      const first = items.shift()!;
      out.description = capitalise(first.label || "Bill");
      items.push({ label: "Everything else", paise: first.paise - rest, qty: 1, members: first.members });
    }
    out.rule = "itemwise";
    out.totalPaise = explicitTotal;
    out.items = items.map((s) => ({
      name: capitalise(s.label || "Item"),
      qty: s.qty,
      amountPaise: s.paise,
      participants: s.members,
      excluded: [],
    }));
    out.charges = charges;
    if (out.items.length > 1 && !firstIsTotal) {
      const said = labelFrom(instructionText, instHits, scanner);
      const cat = categorise(raw.toLowerCase());
      out.description = capitalise(said || (cat === "food" ? "Restaurant bill" : cat === "groceries" ? "Groceries" : cat === "drinks" ? "Drinks" : "Bill"));
    }
  } else if (explicitTotal != null) {
    out.totalPaise = explicitTotal;
  }

  if (out.percents.length === 0 && pctOrder.length) {
    const order = participants.length === pctOrder.length ? participants : namesIn(instructionText);
    if (order.length === pctOrder.length) {
      order.forEach((id, i) => out.percents.push({ member: id, percent: pctOrder[i] }));
    } else {
      out.clarify = { question: `Who gets which share of the ${pctOrder.join("-")} split?`, kind: "participants" };
    }
  }

  if (exactCandidates.length) {
    if (out.totalPaise == null && out.rule !== "itemwise") {
      // "Riya 500, Kabir 300" with no total: the total is the sum.
      out.totalPaise = exactCandidates.reduce((s, e) => s + e.paise, 0);
      out.remainder = out.remainder ?? "equal";
    }
    out.exact = exactCandidates.map((e) => ({ member: e.member, amountPaise: e.paise }));
    out.rule = out.rule ?? "exact";
  }

  // Claims & exclusions on items.
  for (const c of claims) {
    const its = out.items.filter((i) => matchesKeyword(i.name, c.keyword));
    if (its.length) for (const i of its) i.participants = c.members;
    else if (out.rule !== "itemwise" && !participants.length) participants = c.members;
  }
  for (const ex of exclusions) {
    if (ov.ignoreExclusions) continue;
    if (ex.kind === "whole" || (ex.segment && out.rule !== "itemwise")) {
      out.excluded.push(...ex.members);
      continue;
    }
    const its = out.items.filter((i) =>
      ex.kind === "drink"
        ? DRINK_WORDS.some((w) => matchesKeyword(i.name, w)) || (ex.keyword && matchesKeyword(i.name, ex.keyword))
        : ex.kind === "food"
          ? !DRINK_WORDS.some((w) => matchesKeyword(i.name, w))
          : matchesKeyword(i.name, ex.keyword ?? ""),
    );
    if (its.length) {
      for (const i of its) i.excluded.push(...ex.members);
    } else if (ov.excludeWhole?.some((m) => ex.members.includes(m))) {
      out.excluded.push(...ex.members);
    } else {
      out.clarify = {
        question:
          ex.kind === "drink"
            ? `How should I handle ${nameOf(roster, ex.members)} not drinking? I don't know how much of the bill was drinks.`
            : `I couldn't find "${ex.keyword ?? "that"}" on this bill. Leave ${nameOf(roster, ex.members)} out of the whole thing?`,
        kind: "excluded_drinks",
      };
      out.excluded.push(...ex.members);
    }
  }

  if (out.percents.length) out.rule = "percent";
  else if (out.shares.length) out.rule = out.rule === "itemwise" ? "itemwise" : "shares";
  out.rule = out.rule ?? "equal";
  out.participants = participants;
  if (out.totalPaise == null && out.rule !== "itemwise") out.confidence = 0.3;

  finishUnresolved(out, unresolved);
  return out;
}

// ---------------------------------------------------------------------------------------------

function detectIntent(t: string, hasAmount: boolean): Intent {
  if (/\b(settle|settlement|settle up|hisaab|hisab|clear (?:it|all|up))\b/.test(t) && !hasAmount) return "settle_up";
  if (/\b(cancel|delete|remove|undo|scrap|discard|ignore)\b/.test(t) && !hasAmount && /\b(that|this|it|last|the|one|expense|split|entry)\b/.test(t))
    return "delete_expense";
  if (
    /\b(actually|instead|make (?:it|that)|change|edit|correction|correct|update|fix|wrong|not\s+\d)\b/.test(t) ||
    /\b(add|include|remove|exclude|drop)\b/.test(t) && !hasAmount ||
    (/\bpaid\b/.test(t) && /\b(that|it|this)\b/.test(t) && !hasAmount)
  )
    return "edit_expense";
  if (!hasAmount) {
    if (/\b(spen[dt]|spending|expenses?|kharcha|how much (?:did|have) we)\b/.test(t)) return "query_spend";
    if (/\b(owe|owes|owed|balance|balances|dena|lena|due|pending)\b/.test(t)) return "query_balance";
    return "help";
  }
  return "create_expense";
}

function keywordAfter(t: string, del: boolean): string | null {
  const words = t
    .replace(/[?.!]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter(
      (w) =>
        !STOP.has(w) &&
        !/^(cancel|delete|remove|undo|scrap|discard|ignore|one|last|expense|entry|how|much|did|we|spend|spent|spending|on|so|far|this|trip|total|what|was|our|my|whole|kharcha)$/.test(w),
    );
  if (!words.length) return del ? null : null;
  return words.join(" ");
}

interface AmountHit {
  start: number;
  end: number;
  paise: number;
}

export function findAmounts(s: string): AmountHit[] {
  const out: AmountHit[] = [];
  const re = /(?<![\p{L}\d.,+×*:/-])(?:₹\s?|rs\.?\s?|inr\s?)?(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d{1,2}))?\s?(k|l|lakh|lac)?(?![\p{L}\d%:/])/gu;
  for (const m of s.matchAll(re)) {
    const tail = s.slice(m.index! + m[0].length);
    if (/^\s*(?:x|×|pcs|nos|plates?|pieces|shares?|ways?|people|persons?|log|members|of us|%|am|pm|hrs?|days?|nights?)\b/i.test(tail)) continue;
    const paise = parseAmountToPaise(m[0]);
    if (paise == null) continue;
    // "x4", "4 pcs" were excluded above; a lone 1-2 digit number next to an item is often a count,
    // but "chai 40" is a real amount, so we keep small numbers.
    out.push({ start: m.index!, end: m.index! + m[0].length, paise });
  }
  return out;
}

function labelFrom(text: string, hits: { start: number; end: number }[], scanner: Scanner): string {
  let s = text;
  for (const h of [...hits].sort((a, b) => b.start - a.start)) s = s.slice(0, h.start) + " " + s.slice(h.end);
  const words = s
    .replace(/[^\p{L}\s'&-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w) && !scanner.isKnown(w) && !/^(owes|pays|gives|on|didn't|didnt|split)$/.test(w));
  return words.slice(0, 5).join(" ").trim();
}

function chargeType(label: string): SplitCharge["type"] | null {
  if (/\b(gst|cgst|sgst|igst|tax|taxes|vat)\b/.test(label)) return "gst";
  if (/\b(service|sc|service charge)\b/.test(label)) return "service";
  if (/\b(tip|tips)\b/.test(label)) return "tip";
  if (/\b(discount|coupon|off|offer|cashback)\b/.test(label)) return "discount";
  return null;
}
function chargeLabel(type: SplitCharge["type"], label: string) {
  if (type === "gst") return /cgst|sgst|igst/.test(label) ? label.toUpperCase() : "GST";
  return { service: "Service charge", tip: "Tip", discount: "Discount", other: "Charge" }[type] ?? "Charge";
}

function categorise(t: string): Category {
  for (const [cat, re] of CATEGORY_WORDS) if (re.test(t)) return cat;
  return "other";
}

function matchesKeyword(name: string, keyword: string): boolean {
  if (!keyword) return false;
  const n = name.toLowerCase();
  const k = keyword.toLowerCase().replace(/(es|s)$/, "");
  return k.length >= 3 && n.split(/\s+/).some((w) => w.replace(/(es|s)$/, "").startsWith(k) || k.startsWith(w.replace(/(es|s)$/, "")) && w.length >= 3);
}

function finishUnresolved(out: ParsedMessage, unresolved: Map<string, string[]>) {
  out.unresolved = [...unresolved.entries()].map(([name, candidates]) => ({ name, candidates }));
}

function nameOf(roster: Roster, ids: string[]) {
  return ids
    .map((id) => (id === roster.senderId ? "you" : roster.members.find((m) => m.id === id)?.name ?? "them"))
    .join(" and ");
}

function capitalise(s: string) {
  const v = s.trim();
  return v ? v[0].toUpperCase() + v.slice(1) : v;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
