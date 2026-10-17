import { z } from "zod";
import { createSession, normalisePhone, verifyOtp } from "@/lib/server/auth";
import { body, HttpError, json, route } from "@/lib/server/http";

export const POST = route(async (req) => {
  const input = await body(req, z.object({ phone: z.string(), code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code.") }));
  const phone = normalisePhone(input.phone);
  if (!phone) throw new HttpError(400, "Invalid phone number.");
  const res = await verifyOtp(phone, input.code);
  if (!res.ok) throw new HttpError(400, res.error);
  await createSession(res.userId);
  return json({ ok: true, isNew: res.isNew });
});
