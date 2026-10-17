import { z } from "zod";
import { normalisePhone, requestOtp } from "@/lib/server/auth";
import { body, HttpError, json, route } from "@/lib/server/http";

export const POST = route(async (req) => {
  const { phone: raw } = await body(req, z.object({ phone: z.string().min(6).max(20) }));
  const phone = normalisePhone(raw);
  if (!phone) throw new HttpError(400, "Enter a valid 10-digit mobile number.");
  const res = await requestOtp(phone);
  if (!res.ok) throw new HttpError(429, res.error);
  return json({ ok: true, phone, devCode: res.devCode });
});
