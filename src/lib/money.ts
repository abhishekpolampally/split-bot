/** All money is stored and computed in integer paise. */

export function formatINR(paise: number, opts: { sign?: boolean } = {}): string {
  const abs = Math.abs(Math.round(paise));
  const frac = abs % 100 !== 0;
  const str =
    "₹" +
    (abs / 100).toLocaleString("en-IN", {
      minimumFractionDigits: frac ? 2 : 0,
      maximumFractionDigits: 2,
    });
  if (opts.sign && paise < 0) return "−" + str;
  if (opts.sign && paise > 0) return "+" + str;
  return str;
}

/**
 * Parse a human amount into paise: "2,400", "₹640", "2.4k", "1.5L", "rs. 99.50".
 * Returns null when the string isn't a money amount.
 */
export function parseAmountToPaise(raw: string): number | null {
  const s = raw
    .toLowerCase()
    .replace(/₹|rs\.?|inr|rupees?/g, "")
    .replace(/\/-$/, "")
    .replace(/\s+/g, "")
    .trim();
  const m = s.match(/^(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d{1,2}))?(k|l|lakh|lac)?$/);
  if (!m) return null;
  const whole = Number(m[1].replace(/,/g, ""));
  const decimals = m[2] ? Number(m[2].padEnd(2, "0")) : 0;
  let value = whole * 100 + decimals;
  const suffix = m[3];
  if (suffix === "k") value = Math.round((whole + decimals / 100) * 1000 * 100);
  if (suffix && suffix !== "k") value = Math.round((whole + decimals / 100) * 100000 * 100);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

export function upiLink(opts: {
  upiId: string;
  name: string;
  amountPaise: number;
  note: string;
}): string {
  const params = new URLSearchParams({
    pa: opts.upiId,
    pn: opts.name,
    am: (opts.amountPaise / 100).toFixed(2),
    cu: "INR",
    tn: opts.note.slice(0, 50),
  });
  return `upi://pay?${params.toString()}`;
}
