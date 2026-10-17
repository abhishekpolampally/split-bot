import { z } from "zod";
import { CATEGORIES } from "@/lib/split/types";

const paise = z.number().int().min(0).max(1_000_000_000);
const rec = (v: z.ZodType<number>) => z.record(z.string(), v).optional();

/** Validates a SplitSpec coming from the client (edit sheet / manual add). */
export const SpecSchema = z.object({
  description: z.string().trim().min(1, "Add a description.").max(80),
  category: z.enum(CATEGORIES),
  payerId: z.string(),
  totalPaise: paise.nullable(),
  rule: z.enum(["equal", "exact", "percent", "shares", "itemwise"]),
  participants: z.array(z.string()).max(50),
  exact: rec(paise),
  remainder: z.enum(["equal", "payer"]).optional(),
  percents: rec(z.number().min(0).max(100)),
  shares: rec(z.number().min(0).max(1000)),
  adjustments: rec(z.number().int().min(-1_000_000_000).max(1_000_000_000)),
  items: z
    .array(z.object({ name: z.string().trim().min(1).max(60), qty: z.number().int().min(1).max(999), amountPaise: paise, participants: z.array(z.string()) }))
    .max(100)
    .optional(),
  charges: z
    .array(
      z.object({
        type: z.enum(["gst", "service", "tip", "discount", "other"]),
        label: z.string().max(40),
        amountPaise: z.number().int().min(-1_000_000_000).max(1_000_000_000),
      }),
    )
    .max(20)
    .optional(),
});
