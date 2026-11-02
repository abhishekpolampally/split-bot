import { parseAmountToPaise } from "@/lib/money";
import type { Category, SplitCharge } from "@/lib/split/types";
import { findDayRange } from "./dates";
import { emptyParse, type ExpenseRef, type Intent, type Overrides, type ParsedMessage, type Roster } from "./types";

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
  "ne", "ka", "ki", "ke", "hai", "tha", "mein", "me", "ko", "just", "also", "too", "total", "hisaab", "liye", "liya",
  "where", "so", "basically", "guys", "hey",
]);
// Words after "for" / "with" that aren't people, so "cab 500 for office" doesn't ask who Office is.
const NOT_PEOPLE =
  /^(friends?|family|office|work|home|house|flat|kids|guests|team|everyone|trip|night|day|week|month|year|today|tomorrow|tonight|weekend|birthday|party|dinner|lunch|breakfast|two|three|four|five|six|both|them|all|us|you)$/;
const DRINK_WORDS = [
  "beer", "beers", "wine", "drink", "drinks", "alcohol", "cocktail", "cocktails", "whisky", "whiskey",
  "vodka", "rum", "gin", "pint", "pints", "shot", "shots", "booze", "daaru", "daru", "sangria", "mojito",
  "lager", "tequila", "bar",
];
// Labels that describe a whole bill rather than one item on it.
const WHOLE_BILL = /^(dinner|lunch|breakfast|brunch|meal|food|party|outing|trip|order|restaurant|cafe|bar|pub|night out)\b/;
// Segment separators: commas (but not thousands separators like "2,400"), semicolons, newlines,
// "then", and full stops between sentences (not the one in "rs. 500").
const SEGMENT_SPLIT = /(?<!\d),|,(?!\d{2})|[;\n]|\bthen\b|\bplus\b|(?<!\brs)\.(?=\s)/;
// An amount as typed: "350", "₹1,430", "rs 2.5k".
const AMOUNT_RE = String.raw`(?:₹\s?|rs\.?\s?)?(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d{1,2})?k?`;
// What may follow a person's amount: "aman had 350, …", "… 300 worth and …", but not "2 pizzas".
const AMOUNT_END = String.raw`(?=\s*(?:[,.;!?)&]|$|(?:and|then|plus|rupees|rs|only|each|bucks|for|from|on|in|worth|so|but)\b))`;
// "Aman's share is 350" names a whole share; "Aman's drinks were 400" names an extra.
const SHARE_WORDS = /^(share|part|portion|amount|bill|total|cut|contribution)$/;

const CATEGORY_WORDS: [Category, RegExp][] = [
  ["food", /\b(dinner|lunch|breakfast|brunch|food|pizza|biryani|swiggy|zomato|snacks?|coffee|chai|cafe|restaurant|meal|dessert|cake|paneer|chicken|naan|dal|momos?|khana|nashta)\b/],
  ["drinks", /\b(beer|wine|drinks?|bar|pub|cocktails?|daaru|daru|booze)\b/],
  ["travel", /\b(cab|uber|ola|rapido|auto|taxi|petrol|diesel|fuel|toll|flight|train|bus|metro|parking|travel|ride)\b/],
  ["stay", /\b(hotel|airbnb|stay|hostel|room|resort|villa)\b/],
  ["rent", /\b(rent|deposit|brokerage)\b/],
  ["utilities", /\b(electricity|power|wifi|internet|broadband|water|gas|cylinder|maid|cook|bill)\b/],
  ["groceries", /\b(grocer(y|ies)|blinkit|zepto|instamart|bigbasket|vegetables|sabzi|milk|dmart)\b/],
  ["entertainment", /\b(movie|movies|tickets?|concert|netflix|spotify|game|bowling|club|party)\b/],
  ["shopping", /\b(shopping|amazon|flipkart|myntra|gift|clothes)\b/],
];

// A regex fragment matching a run of names: "riya", "me and neha", "kabir, riya & neha".
const NAMES_RE = `([\\p{L}']+(?:\\s*(?:,|&|and|aur|\\+)\\s*[\\p{L}']+)*)`;

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

export function parseWithRules(raw: string, roster: Roster, ov: Overrides = {}, forceIntent?: Intent, now = new Date()): ParsedMessage {
  const scanner = new Scanner(roster, ov.nameMap);
  // Work on a lowercase copy; "blank" spans we've consumed so later passes skip them.
  let t = addUpSums((" " + raw.replace(/@splitbot\b/gi, " ").replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim() + " ").toLowerCase());
  const blank = (start: number, end: number) => {
    t = t.slice(0, start) + " ".repeat(end - start) + t.slice(end);
  };
  const allIds = roster.members.map((m) => m.id);
  const sender = roster.senderId;

  const amountsIn = (s: string) => findAmounts(s);
  const hasAmount = amountsIn(t).length > 0;
  // "remove Neha", "drop me from the cab": taking a person out of a bill is an edit, not a delete.
  const removesPerson = [...t.matchAll(/\b(?:remove|drop|exclude|take\s+out)\s+([\p{L}']+(?:\s+[\p{L}']+)?)/gu)].some((m) =>
    scanner.scan(m[1]).some((h) => !h.all && h.ids.length > 0),
  );
  // "riya wasn't there", "only me and neha": changing who's in a bill.
  const absentRe = /(?<![\p{L}])([\p{L}']+)\s+(?:wasn'?t|was\s+not|weren'?t|were\s+not|didn'?t\s+(?:come|join|go)|did\s+not\s+(?:come|join|go)|skipped|missed)(?![\p{L}])/gu;
  const absentIds = [...t.matchAll(absentRe)].flatMap((m) => scanner.scan(m[1]).filter((h) => !h.all && h.ids.length === 1).flatMap((h) => h.ids));
  const onlyIds = (() => {
    const m = t.match(new RegExp(`\\bonly\\s+${NAMES_RE}`, "u"));
    return m ? scanner.scan(m[1]).filter((h) => h.ids.length > 0).flatMap((h) => h.ids) : [];
  })();
  const intent = forceIntent ?? detectIntent(t, hasAmount, removesPerson, absentIds.length > 0 || onlyIds.length > 0);
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

  const NAMES = NAMES_RE;

  // ---- non-expense intents ------------------------------------------------
  if (intent === "settle_up" || intent === "help") return out;

  if (intent === "query_balance") {
    const others = namesIn(t).filter((id) => id !== sender);
    out.queryMember = others[0] ?? null;
    return out;
  }
  if (intent === "delete_expense") {
    const ref = expenseRefIn(t, scanner, sender, now, "delete");
    out.expenseRef = ref;
    out.queryKeyword = ref.keyword;
    out.queryMember = ref.payer ?? ref.member;
    finishUnresolved(out, unresolved);
    return out;
  }
  if (intent === "query_spend") {
    out.queryKeyword = keywordAfter(t);
    out.queryMember = namesIn(t).find((id) => id !== sender) ?? null;
    if (out.queryKeyword) {
      const cat = categorise(out.queryKeyword);
      if (cat !== "other") out.category = cat;
    }
    return out;
  }

  // ---- payer ---------------------------------------------------------------
  // "maine 600 diya" → "maine diya 600", so the payer pattern sees the words together.
  t = t.replace(/(?<![\p{L}])(maine|mene|humne)\s+((?:₹|rs\.?)?\s?\d[\d.,]*k?)\s+(diya|bhara|paid)(?![\p{L}])/u, "$1 $3 $2");
  const payerRes = [
    new RegExp(`\\bpaid\\s+by\\s+${NAMES}`, "u"),
    new RegExp(`(?<![\\p{L}])([\\p{L}']+)\\s+(?:has\\s+)?(?:paid|payed|pays|covered|ne\\s+(?:diya|pay\\s+kiya|paid|bhara))(?![\\p{L}])`, "u"),
    /(?<![\p{L}])(maine|mene|humne)\s+(?:diya|pay\s+kiya|bhara|paid)(?![\p{L}])/u,
  ];
  for (const re of payerRes) {
    const m = t.match(re);
    if (!m) continue;
    let word = m[1].trim().split(/\s*(?:,|&|and|aur|\+)\s*/)[0];
    // The regexes capture single words; widen to a full name ("riya shah") if one covers this word.
    const wordAt = m.index! + m[0].indexOf(word);
    const winStart = Math.max(0, wordAt - 30);
    const full = scanner.scan(t.slice(winStart, wordAt + word.length + 30)).find((h) => h.start <= wordAt - winStart && h.end >= wordAt - winStart + word.length);
    if (full && full.key !== word) word = full.key;
    const hits = scanner.scan(word);
    if (hits.length && hits[0].ids.length === 1) out.payer = hits[0].ids[0];
    else if (hits.length && hits[0].ids.length > 1) unresolved.set(word, hits[0].ids);
    else if (["maine", "mene", "humne", "i", "me"].includes(word)) out.payer = sender;
    else if (!(word in (ov.nameMap ?? {})) && !STOP.has(word) && !/^\d/.test(word) && !CATEGORY_WORDS.some(([, r]) => r.test(word)))
      unresolved.set(word, []);
    blank(Math.min(m.index!, full ? winStart + full.start : m.index!), Math.max(m.index! + m[0].length, full ? winStart + full.end : 0));
    break;
  }

  // ---- edits ---------------------------------------------------------------
  if (intent === "edit_expense") {
    // "2200 not 2400": the amount after "not" is the old one.
    for (const m of t.matchAll(/\bnot\s+(?:₹\s?|rs\.?\s?)?\d[\d,]*(?:\.\d{1,2})?k?(?![\p{L}\d])/gu)) blank(m.index!, m.index! + m[0].length);
    for (const m of t.matchAll(new RegExp(`\\b(?:add|include|plus|also)\\s+${NAMES}`, "gu"))) {
      out.addParticipants.push(...namesIn(m[1]));
      blank(m.index!, m.index! + m[0].length);
    }
    // "Kabir paid for that, not me" is about the payer, so "not me" doesn't take anyone out.
    const removeWords = /\b(?:paid|payed|covered)\b/i.test(raw) ? "remove|exclude|without|drop|minus|except" : "remove|exclude|without|drop|minus|except|not";
    for (const m of t.matchAll(new RegExp(`\\b(?:${removeWords})\\s+${NAMES}`, "gu"))) {
      out.removeParticipants.push(...namesIn(m[1]));
      blank(m.index!, m.index! + m[0].length);
    }
    for (const m of t.matchAll(absentRe)) {
      const ids = namesIn(m[1]);
      if (!ids.length) continue;
      out.removeParticipants.push(...ids);
      blank(m.index!, m.index! + m[0].length);
    }
    // "make it 60-40 between me and neha"
    const ratio = t.match(/(?<![\d.])(\d{1,3})\s*[-/:]\s*(\d{1,3})(?:\s*[-/:]\s*(\d{1,3}))?(?![\d%])/);
    if (ratio) {
      const parts = [ratio[1], ratio[2], ratio[3]].filter(Boolean).map(Number);
      if (parts.reduce((a, b) => a + b, 0) === 100) {
        blank(ratio.index!, ratio.index! + ratio[0].length);
        const who = t.match(new RegExp(`\\b(?:between|among|amongst|for)\\s+${NAMES}`, "u"));
        const order = who ? namesIn(who[1]) : [];
        if (order.length === parts.length) {
          out.rule = "percent";
          out.percents = order.map((id, i) => ({ member: id, percent: parts[i] }));
          blank(who!.index!, who!.index! + who![0].length);
        }
      }
    }
    const amts = amountsIn(t);
    if (amts.length) out.totalPaise = amts[amts.length - 1].paise;
    if (/\b(equal|equally|evenly|barabar)\b/.test(t)) out.rule = "equal";
    const only = t.match(new RegExp(`\\bonly\\s+${NAMES}`, "u"));
    if (only) out.participants = namesIn(only[1]);
    // Which bill to change: "remove Neha from the cab", "make yesterday's dinner 2000", "that".
    out.expenseRef = expenseRefIn(t, scanner, sender, now, "edit");
    finishUnresolved(out, unresolved);
    return out;
  }

  // ---- create: who had what ----------------------------------------------------
  // "groceries: aman 200" → "groceries, aman 200"; "aman: 200" → "aman 200".
  t = t.replace(/([\p{L}\d']+)\s*:\s+/gu, (_, w: string) => (scanner.isKnown(w) || /^(total|bill|amount)$/.test(w) ? `${w} ` : `${w}, `));
  // "I had the rest", "the rest is mine": what's left of the total is the sender's.
  const restMine =
    /\b(?:the\s+)?rest\s+(?:is\s+)?(?:(?:on|by|paid\s+by|from|for)\s+)?(?:me|i|myself|mine)\b|\bi(?:'ll|\s+will)?\s+(?:had|have|took|take|pay|paid|cover|covered)\s+(?:for\s+)?the\s+rest\b/;
  const restM = t.match(restMine);
  if (restM) {
    out.remainder = "payer";
    blank(restM.index!, restM.index! + restM[0].length);
  }
  const own = personAmounts(t, scanner);
  t = own.text;
  // "I got 2 pizzas for 600": the sender is the buyer here, not the only person in the split.
  t = t.replace(/(?<![\p{L}])(?:i|maine)\s+(?:got|bought|ordered|picked\s+up)(?![\p{L}])/gu, (s) => " ".repeat(s.length));

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
  for (const m of [...t.matchAll(/(?<![\p{L}])([\p{L}']+)\s*\+\s*(?:₹|rs\.?\s*)?((?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d{1,2})?k?)/gu)]) {
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
    // "except neha, aman 350": the last name has an amount of its own, so it isn't left out.
    let names = m[1];
    let span = m[0];
    if (/^\s*(?:₹|rs\.?)?\s?\d/.test(t.slice(m.index! + m[0].length))) {
      const cut = names.search(/\s*(?:,|&|\band\b|\baur\b|\+)\s*[\p{L}']+$/u);
      if (cut > 0) {
        span = span.slice(0, span.length - (names.length - cut));
        names = names.slice(0, cut);
      }
    }
    const ids = namesIn(names);
    for (const w of names.split(/\s*(?:,|&|and|aur|\+)\s*/)) {
      if (w && !scanner.isKnown(w) && !(w in (ov.nameMap ?? {})) && !STOP.has(w) && /^\p{L}+$/u.test(w)) unresolved.set(w, []);
    }
    if (ids.length) {
      const part = partAt(m.index!);
      const amt = findAmounts(part.text)[0];
      const label = amt ? labelFrom(part.text.slice(0, amt.start), [], scanner).split(" ")[0] : "";
      exclusions.push(label ? { members: ids, kind: "item", keyword: label, segment: true } : { members: ids, kind: "whole" });
    }
    blank(m.index!, m.index! + span.length);
  }
  for (const m of [...t.matchAll(new RegExp(`${NAMES}\\s+(?:didn'?t|did not|doesn'?t|does not|don'?t|won'?t|isn'?t|wasn'?t|not|no|skip(?:s|ped)?|skipping|is out of|out of|nahi)\\s*(?:(?:have|having|take|taking|order|ordered|the|any|a|some)\\s+)*([\\p{L}]+)?`, "gu"))]) {
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
    // "2 pizzas for 600": a bare 1-2 digit number before a word, with a price later, is a count.
    const amts = amountsIn(part).filter((a, i, all) => {
      if (i === all.length - 1 || !/^\d{1,2}$/.test(part.slice(a.start, a.end).trim())) return true;
      const next = part.slice(a.end).match(/^\s+([\p{L}']+)/u);
      return !next || scanner.isKnown(next[1]) || STOP.has(next[1]);
    });
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
      // "total" and "bill" are stop words, so check the raw words rather than the label.
      const bare = cleanBefore.replace(/[^\p{L}\s]/gu, " ").replace(/\s+/g, " ").trim();
      if (/^(sub\s?total|subtotal)$/.test(bare)) return;
      if (/^(?:the\s+)?(?:total|grand total|bill|bill total|total bill|amount|total amount|net|net total)(?:\s+(?:is|was|came to|comes to|of))?$/.test(bare)) {
        explicitTotal = a.paise;
        if (after.trim()) instructionText += " " + after;
        return;
      }
      // "riya 500" / "500 riya" / "riya owes 500" / "me 830" → an exact amount for that person
      const personOnly = !label && hits.length === 1 && hits[0].ids.length === 1 && !hits[0].all;
      if (personOnly || (isOwes && members.length === 1 && !hits[0]?.self)) {
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
  // "kabir and i had coffee for 360"
  if (!description && claims.length) description = claims[0].keyword;
  // "kabir had the beer for 540"
  if (!description && own.items.length) description = own.items[0];
  out.description = description ? capitalise(description) : null;
  out.category = categorise(raw.toLowerCase());

  // "snacks 300 for priya" with no Priya in the group: ask rather than split among everyone.
  const labelWords = new Set([...segs.map((x) => x.label), description].join(" ").split(/\s+/));
  for (const m of t.matchAll(new RegExp(`\\b(?:for|with|between|among|amongst)\\s+${NAMES}`, "gu"))) {
    for (const w of m[1].split(/\s*(?:,|&|and|aur|\+)\s*/)) {
      const person =
        /^\p{L}{3,}$/u.test(w) &&
        !scanner.isKnown(w) &&
        !(w in (ov.nameMap ?? {})) &&
        !STOP.has(w) &&
        !labelWords.has(w) &&
        !NOT_PEOPLE.test(w) &&
        !DRINK_WORDS.includes(w) &&
        !CATEGORY_WORDS.some(([, r]) => r.test(w)) &&
        !chargeType(w);
      if (person) unresolved.set(w, []);
    }
  }

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
    // Only when the first line names the whole outing ("dinner", "bill"), not a dish ("pizza 900, beer 600").
    const firstIsTotal =
      explicitTotal == null && items.length >= 2 && items[0].paise > rest && exclusions.length + claims.length > 0 && WHOLE_BILL.test(items[0].label);
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
    // If people are already named, the ratio must match them; don't guess a subset.
    const order = participants.length ? participants : namesIn(instructionText);
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
      out.totalIsSum = true;
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

// Words that only ever mean "delete", and ones that also show up in edits ("remove Riya").
const DELETE_VERB = /\b(delete|cancel|undo|scrap|discard|erase|trash|get rid of|hata(?:o|do|dena)?|mita(?:o|do|dena)?)\b/;
const SOFT_DELETE_VERB = /\b(remove|drop|ignore|take (?:off|out))\b/;
// Words that point at an existing bill rather than describe a new one.
const POINTS_AT_BILL = /\b(that|this|it|last|latest|previous|the|one|expense|split|entry|bill|my|our)\b/;

function detectIntent(t: string, hasAmount: boolean, removesPerson: boolean, changesPeople: boolean): Intent {
  if (/\b(settle|settlement|settle up|hisaab|hisab|clear (?:it|all|up))\b/.test(t) && !hasAmount) return "settle_up";
  // An amount after a delete word picks out a bill ("delete the 640 cab"); it isn't a new expense.
  const startsWithVerb = new RegExp(`^\\s*(?:please\\s+|pls\\s+)?${DELETE_VERB.source}`).test(t);
  if (!removesPerson) {
    if (DELETE_VERB.test(t) && (!hasAmount || startsWithVerb || POINTS_AT_BILL.test(t))) return "delete_expense";
    if (SOFT_DELETE_VERB.test(t) && (POINTS_AT_BILL.test(t) || (!hasAmount && /\b(remove|drop)\b/.test(t)))) return "delete_expense";
  }
  if (
    /\b(actually|instead|make (?:it|that)|change|edit|correction|correct|update|fix|wrong)\b|\bnot\s+\d/.test(t) ||
    // "make yesterday's dinner 2000": a message opening with "make" corrects a bill.
    /^\s*(?:please\s+|pls\s+)?make\b/.test(t) ||
    /\b(add|include|remove|exclude|drop)\b/.test(t) && !hasAmount ||
    (/\bpaid\b/.test(t) && /\b(that|it|this)\b/.test(t) && !hasAmount) ||
    // "riya wasn't there", "only me and neha in the cab", "split the pizza equally"
    (!hasAmount && changesPeople) ||
    (!hasAmount && /\b(split|divide)\b.*\b(equal|equally|evenly|barabar)\b/.test(t))
  )
    return "edit_expense";
  if (!hasAmount) {
    if (/\b(spen[dt]|spending|expenses?|kharcha|how much (?:did|have) we)\b/.test(t)) return "query_spend";
    if (/\b(owe|owes|owed|balance|balances|dena|lena|due|pending)\b/.test(t)) return "query_balance";
    return "help";
  }
  return "create_expense";
}

function keywordAfter(t: string): string | null {
  const words = t
    .replace(/[?.!]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter(
      (w) =>
        !STOP.has(w) &&
        !/^(cancel|delete|remove|undo|scrap|discard|ignore|one|last|expense|entry|how|much|did|we|spend|spent|spending|on|so|far|this|trip|total|what|was|our|my|whole|kharcha)$/.test(w),
    );
  if (!words.length) return null;
  return words.join(" ");
}

// Words in a request that say "a bill" without saying which one.
const REF_FILLER =
  /^(cancel|delete|remove|undo|scrap|discard|ignore|erase|trash|drop|get|rid|take|off|out|hata|hatao|hatado|hatadena|mita|mitao|mitado|mitadena|one|ones|last|latest|previous|recent|newest|most|second|2nd|before|but|expense|expenses|entry|entries|bill|bills|split|item|transaction|record|thing|stuff|something|that|this|it|let's|lets|let|us|we|our|my|can|you|kindly|karo|kar|do|de|dena|wala|wali|vala|vali|please|pls|plz|again|wrong|mistake|by|mistakenly|accidentally|added|logged|made|created|entered|did|done|bought|went|payer|amount|price|rule|people|names|oops|sorry|wait|hey|ok|okay|arre|yaar|bhai|no|just|everything|all)$/;

/** How precisely a set of clues picks out one bill. "The last one" is precise; "the bill" isn't. */
function refConfidence(r: ExpenseRef): number {
  let c = 0;
  if (r.ordinal) c += 0.9;
  if (r.day) c += 0.5;
  if (r.amountPaise) c += 0.6;
  if (r.payer) c += 0.5;
  if (r.member) c += 0.4;
  // A long run of leftover words usually means we didn't understand the message.
  if (r.keyword) c += r.keyword.split(" ").length <= 2 ? 0.6 : 0.3;
  return Math.min(1, Math.round(c * 100) / 100);
}

/**
 * The clues in a message about which existing bill it means. `t` is the lowercased message.
 * In "edit" mode amounts and names are the change being asked for ("make it 2000", "Kabir paid"),
 * not clues, and the keyword only comes from phrases that point at a bill ("from the cab").
 */
function expenseRefIn(text: string, scanner: Scanner, sender: string, now: Date, mode: "delete" | "edit"): ExpenseRef {
  let t = text;
  const blank = (start: number, end: number) => {
    t = t.slice(0, start) + " ".repeat(end - start) + t.slice(end);
  };
  const ref: ExpenseRef = { ordinal: null, keyword: null, amountPaise: null, payer: null, member: null, day: null, confidence: 0 };

  // Days first, so the "last" in "last saturday" isn't read as "the latest".
  const day = findDayRange(t, now);
  if (day) {
    ref.day = { from: day.from, to: day.to, label: day.label };
    blank(day.start, day.end);
  }

  const second = t.match(/\b(?:(?:second|2nd)\s+(?:last|latest|most\s+recent)|last\s+but\s+one|(?:the\s+)?one\s+before\s+(?:that|this|it|the\s+last(?:\s+one)?|last)|before\s+(?:that|the\s+last(?:\s+one)?))\b/);
  if (second) {
    ref.ordinal = 2;
    blank(second.index!, second.index! + second[0].length);
  } else if (/\b(last|latest|previous|recent|newest|that|this|it|undo)\b/.test(t)) {
    ref.ordinal = 1;
  }

  const isWord = (w: string) =>
    w && !STOP.has(w) && !REF_FILLER.test(w) && !scanner.isKnown(w) && !/^(of|so|for|from|on|at|which|who|what|was|were|i|me)$/.test(w);

  if (mode === "edit") {
    const words: string[] = [];
    const pointers = [
      /\b(?:from|in|to|for|on)\s+(?:the\s+|that\s+|my\s+|our\s+)?([\p{L}]+)/gu,
      /\b(?:make|change|edit|fix|update|correct)\s+(?:the\s+|that\s+|my\s+|our\s+)?([\p{L}]+)/gu,
      /\b([\p{L}]+)\s+(?:one|bill|expense|wala|vala|wali|vali)\b/gu,
      /\b(?:split|divide)\s+(?:the|that|my|our)\s+([\p{L}]+)/gu,
      // "the dinner was 2200, not 2400"
      /\b(?:the|that|my|our)\s+([\p{L}]+)\s+(?:was|is|should\s+be|should\s+have\s+been|should've\s+been|came\s+to)\b/gu,
    ];
    for (const re of pointers) for (const m of t.matchAll(re)) if (isWord(m[1]) && !words.includes(m[1])) words.push(m[1]);
    ref.keyword = words.length ? words.join(" ") : null;
    ref.confidence = refConfidence(ref);
    return ref;
  }

  const amount = findAmounts(t)[0];
  if (amount) {
    ref.amountPaise = amount.paise;
    blank(amount.start, amount.end);
  }

  const paid =
    t.match(/\bpaid\s+by\s+([\p{L}']+(?:\s+[\p{L}']+)?)/u) ??
    t.match(/(?<![\p{L}])([\p{L}']+(?:\s+[\p{L}']+)?)\s+(?:had\s+|has\s+)?(?:paid|payed|covered|ne\s+(?:diya|pay\s+kiya|paid|bhara))(?![\p{L}])/u);
  if (paid) {
    const hit = scanner.scan(paid[1]).find((h) => h.ids.length === 1);
    if (hit) ref.payer = hit.ids[0];
    else if (/\b(maine|mene)\b/.test(paid[1])) ref.payer = sender;
    if (ref.payer) blank(paid.index!, paid.index! + paid[0].length);
  }
  const named = scanner.scan(t.replace(/'s\b/g, "  ")).find((h) => h.ids.length === 1 && !h.all);
  if (named) {
    if (!ref.payer) ref.member = named.ids[0];
    blank(named.start, named.end);
  }

  const words = t
    .replace(/'s\b/g, " ")
    .replace(/[^\p{L}\s']/gu, " ")
    .split(/\s+/)
    .filter(isWord);
  ref.keyword = words.length ? words.join(" ") : null;
  ref.confidence = refConfidence(ref);
  return ref;
}

/** Which bill a message means, for parsers (like the LLM) that only return a keyword. */
export function parseExpenseRef(raw: string, roster: Roster, mode: "delete" | "edit", now = new Date()): ExpenseRef {
  const t = (" " + raw.replace(/@splitbot\b/gi, " ").replace(/\s+/g, " ").trim() + " ").toLowerCase();
  return expenseRefIn(t, new Scanner(roster), roster.senderId, now, mode);
}

interface AmountHit {
  start: number;
  end: number;
  paise: number;
}

/** "390 + 440" → "830", so a sum reads as one amount. "arjun +200" (an adjustment) is left alone. */
function addUpSums(t: string): string {
  const term = String.raw`(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d{1,2})?k?`;
  return t.replace(new RegExp(`(?<![\\d,])(?<!\\d\\.)${term}(?:\\s*\\+\\s*${term})+(?![\\p{L}\\d])`, "gu"), (s) => {
    const parts = s.split("+").map((x) => parseAmountToPaise(x.trim()));
    if (parts.some((x) => x == null)) return s;
    const p = parts.reduce<number>((a, b) => a + b!, 0);
    return p % 100 ? (p / 100).toFixed(2) : String(p / 100);
  });
}

/**
 * Ways of saying one person's own amount, rewritten to "aman 350" so the segment pass reads it
 * as an exact share: "Aman took something for 350", "Neha only had a coffee for 100", "I had
 * 830", "Aman owes me 350", "Rohan's share is 250".
 *
 * Naming an item on a bill with a total, "Aman's drinks were 400" or "Kabir had the beer for
 * 540", is an extra on top of an equal share instead, written "aman +400" for the adjustment pass;
 * once a message has one, a bare "Rohan's 300" is an extra too. With no other amount in the
 * message, the item's price is the person's whole share. Returns the item words, for a label.
 */
function personAmounts(t: string, scanner: Scanner): { text: string; items: string[] } {
  const isPerson = (w: string) => {
    const hits = scanner.scan(w);
    return hits.length === 1 && hits[0].ids.length === 1 && !hits[0].all && hits[0].start === 0 && hits[0].end === w.length;
  };
  // "kabir and i had coffee for 360" is a shared item, not Arjun's own amount.
  const inList = (before: string) => {
    const m = before.match(/([\p{L}']+)\s*(?:,|&|\band\b|\baur\b|\+)\s*$/u);
    return !!m && scanner.isKnown(m[1]);
  };
  const otherAmounts = findAmounts(t).length > 1;
  const items: string[] = [];
  let extras = false;
  t = t.replace(
    new RegExp(`(?<![\\p{L}])([\\p{L}]+)'s\\s+([\\p{L}]+)\\s+(?:(?:is|was|were|are|=|cost|costs|came\\s+to|for)\\s+)?(${AMOUNT_RE})${AMOUNT_END}`, "gu"),
    (s, name: string, word: string, amt: string) => {
      if (!otherAmounts || !isPerson(name) || SHARE_WORDS.test(word) || scanner.isKnown(word) || /^(is|was|were|are)$/.test(word)) return s;
      extras = true;
      return `${name} +${amt}`;
    },
  );
  t = t.replace(
    new RegExp(`(?<![\\p{L}])([\\p{L}]+)'s\\s+(?:(share|part|portion|amount|bill|total|cut|contribution)\\s+)?(?:(?:is|was|=|comes\\s+to|came\\s+to)\\s+)?(${AMOUNT_RE})${AMOUNT_END}`, "gu"),
    (s, name: string, shareWord: string | undefined, amt: string) => {
      if (!isPerson(name)) return s;
      return extras && !shareWord ? `${name} +${amt}` : `${name} ${amt}`;
    },
  );
  t = t.replace(
    new RegExp(
      `(?<![\\p{L}])([\\p{L}']+)\\s+(?:(only|just)\\s+|also\\s+)?(?:took|had|has|ordered|got|ate|drank|spent|used|bought|owes|owe)\\s+(?:(?:me|us)\\s+)?(?:(?:a|an|some|the)\\s+)?(?:([\\p{L}]+)\\s+)?(?:(?:for|worth|of|at|=)\\s+)?(${AMOUNT_RE})(?:\\s+worth)?${AMOUNT_END}`,
      "gu",
    ),
    (s, name: string, only: string | undefined, word: string | undefined, amt: string, offset: number, whole: string) => {
      if (!isPerson(name) || inList(whole.slice(0, offset)) || (word && scanner.isKnown(word))) return s;
      const item = word && !/^(something|stuff|things?|items?|anything|food)$/.test(word) ? word : null;
      if (item) items.push(item);
      return item && otherAmounts && !only ? `${name} +${amt}` : `${name} ${amt}`;
    },
  );
  return { text: t, items };
}

export function findAmounts(s: string): AmountHit[] {
  const out: AmountHit[] = [];
  // Amounts may end in "/-" ("640/-"), the usual Indian way of writing rupees.
  const re = /(?<![\p{L}\d.,+×*:/-])(?:₹\s?|rs\.?\s?|inr\s?)?(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d{1,2}))?\s?(k|l|lakh|lac)?(?:\/-)?(?![\p{L}\d%:/])/gu;
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

export function categorise(t: string): Category {
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
