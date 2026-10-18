import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { body, json, requireUser, route } from "@/lib/server/http";

const Token = z.object({ token: z.string().min(20).max(4096) });

/** Save this device's FCM token (called after the user turns notifications on, and on app start). */
export const POST = route(async (req) => {
  const user = await requireUser();
  const { token } = await body(req, Token);
  await db
    .insert(schema.pushTokens)
    .values({ userId: user.id, token })
    .onConflictDoUpdate({ target: schema.pushTokens.token, set: { userId: user.id, lastSeenAt: new Date() } });
  return json({ ok: true });
});

/** Turn notifications off on this device. */
export const DELETE = route(async (req) => {
  const user = await requireUser();
  const { token } = await body(req, Token);
  await db.delete(schema.pushTokens).where(and(eq(schema.pushTokens.token, token), eq(schema.pushTokens.userId, user.id)));
  return json({ ok: true });
});
