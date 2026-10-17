import { destroySession } from "@/lib/server/auth";
import { json, route } from "@/lib/server/http";

export const POST = route(async () => {
  await destroySession();
  return json({ ok: true });
});
