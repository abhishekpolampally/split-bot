import { formatINR } from "@/lib/money";
import type { SplitLine, SplitResult, SplitSpec } from "./types";

/**
 * Deterministic split engine. The LLM never does arithmetic that ships:
 * every per-person amount comes from here, in integer paise.
 *
 * Amounts are computed exactly as fractions, floored to the paisa, and the
 * leftover paise go to the payer (or the biggest share if the payer isn't in
 * the split), so lines always sum to the total.
 */
export function computeSplit(spec: SplitSpec): SplitResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const raw = new Map<string, { items: number; charges: number; adjust: number }>();
  const bump = (id: string, key: "items" | "charges" | "adjust", v: number) => {
    const cur = raw.get(id) ?? { items: 0, charges: 0, adjust: 0 };
    cur[key] += v;
    raw.set(id, cur);
  };

  const participants = unique(spec.participants);
  const adjustments = spec.adjustments ?? {};
  const adjustTotal = sum(Object.values(adjustments));
  let total = spec.totalPaise ?? 0;

  if (spec.rule === "itemwise") {
    const items = spec.items ?? [];
    const charges = spec.charges ?? [];
    if (items.length === 0) errors.push("No items to split.");
    const itemsTotal = sum(items.map((i) => i.amountPaise));
    const chargesTotal = sum(charges.map((c) => c.amountPaise));
    if (spec.totalPaise == null) total = itemsTotal + chargesTotal + adjustTotal;

    const expected = itemsTotal + chargesTotal + adjustTotal;
    const diff = total - expected;
    if (Math.abs(diff) > Math.max(100, Math.round(total * 0.01))) {
      errors.push(
        `Items and charges add up to ${formatINR(expected)}, but the total is ${formatINR(total)}.`,
      );
    } else if (diff !== 0) {
      warnings.push(`${formatINR(Math.abs(diff))} rounding difference spread with the charges.`);
    }

    for (const item of items) {
      const who = unique(item.participants.length ? item.participants : participants);
      if (who.length === 0) {
        errors.push(`Nobody is assigned to ${item.name}.`);
        continue;
      }
      if (item.amountPaise < 0) errors.push(`${item.name} has a negative amount.`);
      for (const m of who) bump(m, "items", item.amountPaise / who.length);
    }

    // Tax, service, tip (and rounding) pro-rated by each person's item subtotal.
    const chargePool = total - itemsTotal - adjustTotal;
    if (chargePool !== 0 && itemsTotal > 0) {
      for (const [m, v] of raw) bump(m, "charges", (chargePool * v.items) / itemsTotal);
    }
  } else {
    if (!(total > 0)) errors.push("I couldn't find the amount.");
    if (participants.length === 0) errors.push("Nobody is in this split.");
    const base = total - adjustTotal;
    if (base < 0) errors.push("Adjustments are larger than the total.");

    switch (spec.rule) {
      case "equal":
        for (const m of participants) bump(m, "items", base / Math.max(1, participants.length));
        break;

      case "exact": {
        const exact = spec.exact ?? {};
        const named = sum(Object.values(exact));
        for (const [m, v] of Object.entries(exact)) bump(m, "items", v);
        const rest = base - named;
        if (rest < 0) {
          errors.push(
            `Named amounts (${formatINR(named)}) are more than the total (${formatINR(base)}).`,
          );
        } else if (rest > 0) {
          const others = participants.filter((m) => !(m in exact));
          if (spec.remainder === "payer" || others.length === 0) {
            bump(spec.payerId, "items", rest);
          } else {
            for (const m of others) bump(m, "items", rest / others.length);
          }
        }
        break;
      }

      case "percent": {
        const given = spec.percents ?? {};
        const givenSum = sum(Object.values(given));
        const others = participants.filter((m) => !(m in given));
        const pct: Record<string, number> = { ...given };
        if (others.length && givenSum < 100) {
          for (const m of others) pct[m] = (100 - givenSum) / others.length;
        }
        const pctSum = sum(Object.values(pct));
        if (Math.abs(pctSum - 100) > 0.01) {
          errors.push(`Percentages add up to ${round2(pctSum)}%, not 100%.`);
        }
        for (const [m, p] of Object.entries(pct)) bump(m, "items", (base * p) / 100);
        break;
      }

      case "shares": {
        const given = spec.shares ?? {};
        const who = unique([...participants, ...Object.keys(given)]);
        const weights = who.map((m) => [m, given[m] ?? 1] as const);
        const totalShares = sum(weights.map(([, w]) => w));
        if (totalShares <= 0) errors.push("Share counts must be positive.");
        else for (const [m, w] of weights) bump(m, "items", (base * w) / totalShares);
        break;
      }
    }
  }

  for (const [m, v] of Object.entries(adjustments)) bump(m, "adjust", v);

  // Floor to paise, then hand leftover paise to the payer.
  const lines: SplitLine[] = [];
  for (const [memberId, v] of raw) {
    const itemsPaise = Math.floor(v.items + 1e-6);
    const chargesPaise = Math.floor(v.items + v.charges + 1e-6) - itemsPaise;
    const adjustPaise = Math.round(v.adjust);
    lines.push({
      memberId,
      itemsPaise,
      chargesPaise,
      adjustPaise,
      totalPaise: itemsPaise + chargesPaise + adjustPaise,
    });
  }
  const leftover = total - sum(lines.map((l) => l.totalPaise));
  if (leftover !== 0 && lines.length) {
    const target =
      lines.find((l) => l.memberId === spec.payerId) ??
      lines.reduce((a, b) => (b.totalPaise > a.totalPaise ? b : a));
    target.chargesPaise += leftover;
    target.totalPaise += leftover;
  }

  for (const l of lines) {
    if (l.totalPaise < 0) errors.push("Someone ended up with a negative share.");
  }

  return {
    ok: errors.length === 0,
    totalPaise: total,
    lines: lines.filter((l) => l.totalPaise !== 0 || participants.includes(l.memberId)),
    errors: unique(errors),
    warnings,
  };
}

/** Itemwise specs list items; everything else is described by its rule. */
export function describeRule(spec: SplitSpec): string {
  switch (spec.rule) {
    case "equal":
      return "split equally";
    case "exact":
      return "exact amounts";
    case "percent":
      return "by percentage";
    case "shares":
      return "by shares";
    case "itemwise":
      return "item-wise";
  }
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
function round2(n: number) {
  return Math.round(n * 100) / 100;
}
