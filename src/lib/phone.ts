/** Phone helpers shared by the browser and the server. Numbers are stored as E.164 ("+919876543210"). */

/** Normalise an Indian (or +CC) phone number to E.164-ish digits with a leading +. */
export function normalisePhone(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) {
    const d = digits.slice(1).replace(/\D/g, "");
    return d.length >= 10 && d.length <= 15 ? "+" + d : null;
  }
  const d = digits.replace(/\D/g, "").replace(/^0+/, "");
  if (d.length === 10) return "+91" + d;
  if (d.length === 12 && d.startsWith("91")) return "+" + d;
  return null;
}

/** "+919876543210" → "+91 98765 43210" for display. */
export function formatPhone(e164: string): string {
  const m = e164.match(/^\+91(\d{5})(\d{5})$/);
  return m ? `+91 ${m[1]} ${m[2]}` : e164;
}
