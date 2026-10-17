export interface Transfer {
  from: string;
  to: string;
  amountPaise: number;
}

/**
 * Minimum-transfer settle-up: repeatedly match the largest debtor with the
 * largest creditor. `net` is paid-minus-owed per member (positive = gets back).
 */
export function simplifyDebts(net: Record<string, number>): Transfer[] {
  const creditors = Object.entries(net)
    .filter(([, v]) => v > 0)
    .map(([m, v]) => ({ m, v }));
  const debtors = Object.entries(net)
    .filter(([, v]) => v < 0)
    .map(([m, v]) => ({ m, v: -v }));
  const transfers: Transfer[] = [];

  while (creditors.length && debtors.length) {
    creditors.sort((a, b) => b.v - a.v);
    debtors.sort((a, b) => b.v - a.v);
    const c = creditors[0];
    const d = debtors[0];
    const v = Math.min(c.v, d.v);
    if (v > 0) transfers.push({ from: d.m, to: c.m, amountPaise: v });
    c.v -= v;
    d.v -= v;
    if (c.v === 0) creditors.shift();
    if (d.v === 0) debtors.shift();
  }
  return transfers;
}
