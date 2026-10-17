import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { body, json, requireUser, route } from "@/lib/server/http";

export const GET = route(async () => {
  const user = await requireUser();
  return json({ user: { id: user.id, phone: user.phone, name: user.name, upiId: user.upiId } });
});

const Patch = z.object({
  name: z.string().trim().min(1, "Enter your name.").max(40).optional(),
  upiId: z
    .string()
    .trim()
    .max(60)
    .regex(/^$|^[\w.\-]{2,}@[a-zA-Z]{2,}$/, "That doesn't look like a UPI ID (name@bank).")
    .optional(),
});

export const PATCH = route(async (req) => {
  const user = await requireUser();
  const input = await body(req, Patch);
  const [updated] = await db
    .update(schema.users)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.upiId !== undefined ? { upiId: input.upiId || null } : {}),
    })
    .where(eq(schema.users.id, user.id))
    .returning();
  // Keep member display names in sync for groups where they used the default name.
  if (input.name) {
    await db.update(schema.members).set({ name: input.name }).where(eq(schema.members.userId, user.id));
  }
  return json({ user: { id: updated.id, phone: updated.phone, name: updated.name, upiId: updated.upiId } });
});
