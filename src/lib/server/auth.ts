import "server-only";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { and, eq, gt, isNull, desc, sql } from "drizzle-orm";
import { db, schema } from "@/db";

export const SESSION_COOKIE = "sb_session";
const SESSION_DAYS = 60;
const OTP_TTL_MIN = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_PER_HOUR = 5;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

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

export async function requestOtp(phone: string): Promise<{ ok: true; devCode?: string } | { ok: false; error: string }> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.otpCodes)
    .where(and(eq(schema.otpCodes.phone, phone), gt(schema.otpCodes.createdAt, new Date(Date.now() - 3600_000))));
  if (count >= OTP_MAX_PER_HOUR) return { ok: false, error: "Too many codes requested. Try again in an hour." };

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.insert(schema.otpCodes).values({
    phone,
    codeHash: sha(`${phone}:${code}`),
    expiresAt: new Date(Date.now() + OTP_TTL_MIN * 60_000),
  });
  await sendSms(phone, `${code} is your SplitBot code. It expires in ${OTP_TTL_MIN} minutes.`);
  return { ok: true, devCode: otpDevMode() ? code : undefined };
}

export function otpDevMode() {
  return process.env.OTP_DEV_MODE !== "false";
}

/** Plug an SMS provider (MSG91, Twilio, …) in here. */
async function sendSms(phone: string, text: string) {
  console.log(`[otp] ${phone}: ${text}`);
}

export async function verifyOtp(phone: string, code: string): Promise<{ ok: true; userId: string; isNew: boolean } | { ok: false; error: string }> {
  const [otp] = await db
    .select()
    .from(schema.otpCodes)
    .where(and(eq(schema.otpCodes.phone, phone), isNull(schema.otpCodes.usedAt), gt(schema.otpCodes.expiresAt, new Date())))
    .orderBy(desc(schema.otpCodes.createdAt))
    .limit(1);
  if (!otp) return { ok: false, error: "That code has expired. Request a new one." };
  if (otp.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, error: "Too many wrong attempts. Request a new code." };

  const a = Buffer.from(otp.codeHash);
  const b = Buffer.from(sha(`${phone}:${code.trim()}`));
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    await db.update(schema.otpCodes).set({ attempts: otp.attempts + 1 }).where(eq(schema.otpCodes.id, otp.id));
    return { ok: false, error: "Wrong code. Check and try again." };
  }
  await db.update(schema.otpCodes).set({ usedAt: new Date() }).where(eq(schema.otpCodes.id, otp.id));

  let [user] = await db.select().from(schema.users).where(eq(schema.users.phone, phone));
  const isNew = !user;
  if (!user) [user] = await db.insert(schema.users).values({ phone }).returning();

  // Claim placeholder members that were added with this phone number.
  await db
    .update(schema.members)
    .set({ userId: user.id })
    .where(and(eq(schema.members.phone, phone), isNull(schema.members.userId)));

  return { ok: true, userId: user.id, isNew };
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await db.insert(schema.sessions).values({ tokenHash: sha(token), userId, expiresAt });
  const jar = await cookies();
  // Secure cookies only over HTTPS (tunnels/production); plain-http LAN testing still works.
  const h = await headers();
  const https = h.get("x-forwarded-proto") === "https" || process.env.COOKIE_SECURE === "true";
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: https,
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, sha(token)));
  jar.delete(SESSION_COOKIE);
}

export async function currentUser() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const [row] = await db
    .select({ user: schema.users })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.tokenHash, sha(token)), gt(schema.sessions.expiresAt, new Date())));
  return row?.user ?? null;
}
