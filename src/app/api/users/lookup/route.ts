import { HttpError, json, requireUser, route } from "@/lib/server/http";
import { lookupByPhone } from "@/lib/server/membership";

const WINDOW_MS = 10 * 60_000;
const MAX_LOOKUPS = 30;
// Per server instance, which is enough to stop someone looping through numbers by hand or script.
const recent = new Map<string, number[]>();

/** "Is this number on SplitBot?" for the owner's add-by-number box. Exact numbers only. */
export const GET = route(async (req) => {
  const user = await requireUser();
  const now = Date.now();
  const hits = (recent.get(user.id) ?? []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= MAX_LOOKUPS) throw new HttpError(429, "Too many lookups. Try again in a few minutes.");
  recent.set(user.id, [...hits, now]);

  const phone = new URL(req.url).searchParams.get("phone") ?? "";
  const res = await lookupByPhone(phone);
  return json(res.phone === user.phone ? { ...res, isYou: true } : res);
});
