import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, schema } from "@/db";
import { normalisePhone } from "@/lib/phone";
import { firebaseAuth } from "./firebase";

export { normalisePhone };

export const SESSION_COOKIE = "sb_session";
/**
 * Sessions roll: each day someone uses the app, the session and cookie are pushed out to a full
 * year again, so people only see the OTP screen as new users, after logging out, or after a year
 * away. (Chrome caps cookie lifetimes at 400 days.)
 */
const SESSION_DAYS = 365;
const DAY_MS = 86400_000;
/** A Firebase ID token is valid for an hour; only accept ones from a sign-in that just happened. */
const MAX_SIGN_IN_AGE_S = 10 * 60;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

type SignIn = { ok: true; userId: string; isNew: boolean } | { ok: false; status: number; error: string };

/**
 * Exchange a Firebase phone sign-in for a SplitBot session. Firebase proves the person owns the
 * number (SMS + reCAPTCHA); after that the app uses its own session cookie as before.
 */
export async function signInWithFirebase(idToken: string): Promise<SignIn> {
  const auth = firebaseAuth();
  if (!auth) return { ok: false, status: 503, error: "Login isn't set up on this server yet." };

  let decoded;
  try {
    decoded = await auth.verifyIdToken(idToken);
  } catch {
    return { ok: false, status: 401, error: "Your sign-in couldn't be verified. Try again." };
  }
  if (decoded.firebase.sign_in_provider !== "phone" || !decoded.phone_number) {
    return { ok: false, status: 400, error: "Sign in with your mobile number." };
  }
  if (Date.now() / 1000 - decoded.auth_time > MAX_SIGN_IN_AGE_S) {
    return { ok: false, status: 401, error: "That sign-in has expired. Request a new code." };
  }
  const phone = normalisePhone(decoded.phone_number);
  if (!phone) return { ok: false, status: 400, error: "That phone number isn't supported." };

  // Match on phone so accounts from before Firebase keep their groups and balances.
  let [user] = await db.select().from(schema.users).where(eq(schema.users.phone, phone));
  const isNew = !user;
  if (!user) [user] = await db.insert(schema.users).values({ phone, firebaseUid: decoded.uid }).returning();
  else if (user.firebaseUid !== decoded.uid) {
    [user] = await db.update(schema.users).set({ firebaseUid: decoded.uid }).where(eq(schema.users.id, user.id)).returning();
  }

  // Link members the group owner added with this number before the person signed up.
  await db
    .update(schema.members)
    .set({ userId: user.id })
    .where(and(eq(schema.members.phone, phone), isNull(schema.members.userId)));

  return { ok: true, userId: user.id, isNew };
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * DAY_MS);
  await db.insert(schema.sessions).values({ tokenHash: sha(token), userId, expiresAt });
  await setSessionCookie(token, expiresAt);
}

async function setSessionCookie(token: string, expiresAt: Date) {
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

/**
 * Extend an active session to a full year again, at most once a day (so the chat's polling
 * doesn't write on every request). Call with the session row an API request just loaded.
 */
export async function renewSession(session: { tokenHash: string; expiresAt: Date }) {
  const now = Date.now();
  if (session.expiresAt.getTime() > now + (SESSION_DAYS - 1) * DAY_MS) return;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || sha(token) !== session.tokenHash) return;
  const expiresAt = new Date(now + SESSION_DAYS * DAY_MS);
  await db.update(schema.sessions).set({ expiresAt }).where(eq(schema.sessions.tokenHash, session.tokenHash));
  await setSessionCookie(token, expiresAt);
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, sha(token)));
  jar.delete(SESSION_COOKIE);
}

/** Hash of the session cookie, as stored in `sessions.token_hash`, or null when logged out. */
export async function sessionTokenHash() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? sha(token) : null;
}

export async function currentUser() {
  const hash = await sessionTokenHash();
  if (!hash) return null;
  const [row] = await db
    .select({ user: schema.users, expiresAt: schema.sessions.expiresAt })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.tokenHash, hash), gt(schema.sessions.expiresAt, new Date())));
  if (!row) {
    // Expired, logged out elsewhere, or from before a database reset: drop the dead cookie so the
    // next page load goes straight to /login instead of loading the app and bouncing.
    (await cookies()).delete(SESSION_COOKIE);
    return null;
  }
  await renewSession({ tokenHash: hash, expiresAt: row.expiresAt });
  return row.user;
}
