import { z } from "zod";
import { createSession, signInWithFirebase } from "@/lib/server/auth";
import { body, HttpError, json, route } from "@/lib/server/http";

/** The browser signs in with Firebase phone auth, then posts the ID token here for a session. */
export const POST = route(async (req) => {
  const { idToken } = await body(req, z.object({ idToken: z.string().min(20).max(4096) }));
  const res = await signInWithFirebase(idToken);
  if (!res.ok) throw new HttpError(res.status, res.error);
  await createSession(res.userId);
  return json({ ok: true, isNew: res.isNew });
});
