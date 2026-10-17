export type SplitRule = "equal" | "exact" | "percent" | "shares" | "itemwise";

export const CATEGORIES = [
  "food",
  "drinks",
  "travel",
  "stay",
  "groceries",
  "utilities",
  "rent",
  "entertainment",
  "shopping",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface SplitItem {
  name: string;
  qty: number;
  amountPaise: number;
  /** Member ids sharing this item. Empty means "the default participants". */
  participants: string[];
}

export interface SplitCharge {
  type: "gst" | "service" | "tip" | "discount" | "other";
  label: string;
  /** Negative for discounts. */
  amountPaise: number;
}

/**
 * The fully-resolved description of an expense split. Everything references
 * member ids. Produced by the parser (LLM or rules), consumed by the engine.
 */
export interface SplitSpec {
  description: string;
  category: Category;
  payerId: string;
  /** Null means "sum of items + charges" (item-wise only). */
  totalPaise: number | null;
  rule: SplitRule;
  /** Default participants (who shares the bill / un-tagged items). */
  participants: string[];
  /** rule=exact: fixed amounts per member. */
  exact?: Record<string, number>;
  /** rule=exact: who absorbs what's left after the named amounts. */
  remainder?: "equal" | "payer";
  /** rule=percent: percent per member (0-100). */
  percents?: Record<string, number>;
  /** rule=shares: share count per member (default 1). */
  shares?: Record<string, number>;
  /** Fixed offsets added on top of the base rule ("Arjun +200"). */
  adjustments?: Record<string, number>;
  items?: SplitItem[];
  charges?: SplitCharge[];
}

export interface SplitLine {
  memberId: string;
  itemsPaise: number;
  chargesPaise: number;
  adjustPaise: number;
  totalPaise: number;
}

export interface SplitResult {
  ok: boolean;
  totalPaise: number;
  lines: SplitLine[];
  errors: string[];
  warnings: string[];
}
