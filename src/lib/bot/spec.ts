import { formatINR } from "@/lib/money";
import { computeSplit } from "@/lib/split/engine";
import type { SplitResult, SplitSpec } from "@/lib/split/types";
import type { Overrides, ParsedMessage, Roster } from "./types";

export interface ClarifyOption {
  label: string;
  patch: Overrides;
}

export interface Question {
  text: string;
  options: ClarifyOption[];
  /** Multi-select member chips; the patch is built from the selection. */
  multi?: { field: "participants"; preselected: string[] };
  hint?: string;
}

export type BuildOutcome =
  | { kind: "spec"; spec: SplitSpec; result: SplitResult; flags: string[] }
  | { kind: "question"; question: Question }
  | { kind: "reply"; text: string };

/**
 * Turn a parse (+ clarification answers) into a validated SplitSpec, or decide
 * what to ask. When `forceDefaults` is set (we've already asked twice) we stop
 * asking and fall back to the PRD defaults, flagging what we guessed.
 */
export function buildSpec(
  p: ParsedMessage,
  roster: Roster,
  ov: Overrides,
  forceDefaults = false,
): BuildOutcome {
  const flags: string[] = [];
  const ids = new Set(roster.members.map((m) => m.id));
  const all = roster.members.map((m) => m.id);
  const name = (id: string) =>
    id === roster.senderId ? "you" : (roster.members.find((m) => m.id === id)?.name ?? "someone");

  // 1. Names we couldn't pin down.
  const unresolved = p.unresolved.filter((u) => !(ov.nameMap && u.name in ov.nameMap));
  if (unresolved.length) {
    const u = unresolved[0];
    if (forceDefaults) {
      flags.push("names");
    } else if (u.candidates.length > 1) {
      return {
        kind: "question",
        question: {
          text: `Which ${cap(u.name)} do you mean?`,
          options: u.candidates.map((id) => ({
            label: roster.members.find((m) => m.id === id)?.name ?? id,
            patch: { nameMap: { ...ov.nameMap, [u.name]: id } },
          })),
        },
      };
    } else {
      return {
        kind: "question",
        question: {
          text: `I don't see "${cap(u.name)}" in this group. Who did you mean?`,
          options: [
            ...roster.members.map((m) => ({
              label: m.id === roster.senderId ? "Me" : m.name,
              patch: { nameMap: { ...ov.nameMap, [u.name]: m.id } },
            })),
            { label: "Ignore", patch: { nameMap: { ...ov.nameMap, [u.name]: "" } } },
          ],
          hint: `Add ${cap(u.name)} from the group info screen if they're new.`,
        },
      };
    }
  }

  // 2. Parser-level questions.
  if (p.clarify && !forceDefaults) {
    if (p.clarify.kind === "participants" && !ov.participants) {
      return {
        kind: "question",
        question: {
          text: p.clarify.question,
          options: [],
          multi: { field: "participants", preselected: [roster.senderId] },
        },
      };
    }
    if (p.clarify.kind === "excluded_drinks" && !ov.excludeWhole && !ov.ignoreExclusions) {
      const who = p.excluded;
      return {
        kind: "question",
        question: {
          text: p.clarify.question,
          options: [
            { label: `Leave ${who.map(name).join(" & ")} out`, patch: { excludeWhole: who } },
            { label: "Split equally anyway", patch: { ignoreExclusions: true } },
          ],
          hint: 'Or send the drinks separately, e.g. "@splitbot drinks 600 except Riya".',
        },
      };
    }
  } else if (p.clarify && forceDefaults) {
    flags.push("participants");
  }

  // 3. Amount.
  const total = ov.totalPaise ?? p.totalPaise;
  if (p.rule !== "itemwise" && !(total && total > 0)) {
    return {
      kind: "reply",
      text: 'I couldn\'t find an amount in that. Try something like "@splitbot cab 640, me and Neha".',
    };
  }

  // 4. Who's in.
  const valid = (xs: string[]) => xs.filter((x) => ids.has(x));
  const payer = ov.payer ?? (p.payer && ids.has(p.payer) ? p.payer : roster.senderId);
  const excluded = new Set(p.excluded.filter((x) => ids.has(x)));
  let participants = valid(ov.participants ?? (p.participants.length ? p.participants : all));
  participants = participants.filter((x) => !excluded.has(x));
  if (participants.length === 0) participants = valid(all).filter((x) => !excluded.has(x));

  const rule = p.rule ?? "equal";
  const spec: SplitSpec = {
    description: (p.description || "Expense").slice(0, 80),
    category: p.category ?? "other",
    payerId: payer,
    totalPaise: total ?? null,
    rule,
    participants,
  };

  if (rule === "exact") {
    spec.exact = Object.fromEntries(p.exact.filter((e) => ids.has(e.member)).map((e) => [e.member, e.amountPaise]));
    spec.remainder = p.remainder ?? "equal";
    // Named people should be in the split even if the default list didn't have them.
    spec.participants = [...new Set([...participants, ...Object.keys(spec.exact)])];
  }
  if (rule === "percent") {
    spec.percents = Object.fromEntries(p.percents.filter((e) => ids.has(e.member)).map((e) => [e.member, e.percent]));
    spec.participants = [...new Set([...Object.keys(spec.percents), ...(p.participants.length ? participants : [])])];
  }
  if (p.shares.length) {
    spec.shares = Object.fromEntries(p.shares.filter((e) => ids.has(e.member)).map((e) => [e.member, e.shares]));
  }
  if (p.adjustments.length) {
    spec.adjustments = Object.fromEntries(p.adjustments.filter((e) => ids.has(e.member)).map((e) => [e.member, e.amountPaise]));
  }
  if (rule === "itemwise") {
    spec.items = p.items.map((i) => {
      const base = valid(i.participants.length ? i.participants : participants);
      const drop = new Set([...i.excluded, ...excluded]);
      const who = base.filter((x) => !drop.has(x));
      return {
        name: i.name.slice(0, 60),
        qty: Math.max(1, Math.round(i.qty || 1)),
        amountPaise: i.amountPaise,
        participants: who.length ? who : base,
      };
    });
    spec.charges = p.charges;
  }

  if (payer !== roster.senderId) flags.push("payer");
  if (p.confidence < 0.85) flags.push("amount");

  const result = computeSplit(spec);
  if (!result.ok) {
    if (rule === "itemwise" && spec.items?.length && !forceDefaults) {
      const sum =
        spec.items.reduce((s, i) => s + i.amountPaise, 0) +
        (spec.charges ?? []).reduce((s, c) => s + c.amountPaise, 0);
      return {
        kind: "question",
        question: {
          text: `${result.errors[0]} Which total should I use?`,
          options: [
            { label: `Use ${formatINR(sum)}`, patch: { totalPaise: sum } },
            ...(total ? [{ label: `Keep ${formatINR(total)}`, patch: { totalPaise: total } }] : []),
          ],
        },
      };
    }
    return { kind: "reply", text: `${result.errors.join(" ")} Could you rephrase it?` };
  }

  return { kind: "spec", spec, result, flags };
}

function cap(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
