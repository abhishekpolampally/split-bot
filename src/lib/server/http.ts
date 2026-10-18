import "server-only";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import type { ZodType } from "zod";
import { db, schema } from "@/db";
import type { Group, Member, User } from "@/db/schema";
import { currentUser } from "./auth";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const json = <T>(data: T, status = 200) => NextResponse.json(data, { status });

/** Wrap a route handler: turns HttpErrors and validation errors into JSON responses. */
export function route<C>(fn: (req: Request, ctx: C) => Promise<Response>) {
  return async (req: Request, ctx: C) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      // Drizzle wraps driver errors as "Failed query: …"; the real reason is in `cause`.
      const cause = (e as { cause?: { message?: string; code?: string } }).cause;
      console.error(e, cause ? `\nCaused by: ${cause.code ?? ""} ${cause.message ?? cause}` : "");
      return json({ error: "Something went wrong." }, 500);
    }
  };
}

export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) throw new HttpError(401, "Please log in.");
  return user;
}

export async function requireMember(groupId: string): Promise<{ user: User; group: Group; me: Member }> {
  const user = await requireUser();
  const [row] = await db
    .select({ group: schema.groups, me: schema.members })
    .from(schema.members)
    .innerJoin(schema.groups, eq(schema.groups.id, schema.members.groupId))
    .where(and(eq(schema.members.groupId, groupId), eq(schema.members.userId, user.id)));
  if (!row) throw new HttpError(404, "Group not found.");
  return { user, ...row };
}

export async function body<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "Invalid JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid input.");
  return parsed.data;
}
