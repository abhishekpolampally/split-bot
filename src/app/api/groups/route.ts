import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { PALETTE, pickColor } from "@/lib/colors";
import { normalisePhone } from "@/lib/server/auth";
import { body, HttpError, json, requireUser, route } from "@/lib/server/http";
import { groupLedger } from "@/lib/server/ledger";
import { postMessage } from "@/lib/server/messages";

export const GET = route(async () => {
  const user = await requireUser();
  const mine = await db
    .select({ group: schema.groups, me: schema.members })
    .from(schema.members)
    .innerJoin(schema.groups, eq(schema.groups.id, schema.members.groupId))
    .where(eq(schema.members.userId, user.id));

  const groups = await Promise.all(
    mine.map(async ({ group, me }) => {
      const [last] = await db
        .select({ m: schema.messages, sender: schema.members.name })
        .from(schema.messages)
        .leftJoin(schema.members, eq(schema.members.id, schema.messages.senderMemberId))
        .where(eq(schema.messages.groupId, group.id))
        .orderBy(desc(schema.messages.id))
        .limit(1);
      const [{ unread }] = await db
        .select({ unread: sql<number>`count(*)::int` })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.groupId, group.id),
            gt(schema.messages.id, me.lastReadMessageId),
            sql`${schema.messages.senderMemberId} is distinct from ${me.id}`,
          ),
        );
      const ledger = await groupLedger(group.id);
      const who = last ? (last.m.senderMemberId === me.id ? "You" : (last.sender ?? "SplitBot")) : null;
      return {
        id: group.id,
        name: group.name,
        color: group.color,
        memberCount: ledger.members.length,
        net: ledger.net[me.id] ?? 0,
        unread,
        last: last ? { text: `${who}: ${last.m.body}`, at: last.m.createdAt.toISOString() } : null,
        createdAt: group.createdAt.toISOString(),
      };
    }),
  );
  groups.sort((a, b) => (b.last?.at ?? b.createdAt).localeCompare(a.last?.at ?? a.createdAt));
  return json({ groups });
});

const Create = z.object({
  name: z.string().trim().min(1, "Give the group a name.").max(50),
  members: z
    .array(z.object({ name: z.string().trim().min(1).max(40), phone: z.string().max(20).optional() }))
    .max(30)
    .default([]),
});

export const POST = route(async (req) => {
  const user = await requireUser();
  if (!user.name) throw new HttpError(400, "Set your name first.");
  const input = await body(req, Create);

  const group = await db.transaction(async (tx) => {
    const [g] = await tx
      .insert(schema.groups)
      .values({
        name: input.name,
        color: pickColor(input.name),
        inviteToken: randomBytes(9).toString("base64url"),
        createdBy: user.id,
      })
      .returning();
    await tx.insert(schema.members).values({ groupId: g.id, userId: user.id, name: user.name!, phone: user.phone, color: PALETTE[0] });

    let i = 1;
    for (const m of input.members) {
      const phone = m.phone ? normalisePhone(m.phone) : null;
      let userId: string | null = null;
      if (phone) {
        const [existing] = await tx.select().from(schema.users).where(eq(schema.users.phone, phone));
        if (existing && existing.id !== user.id) userId = existing.id;
        if (existing?.id === user.id) continue;
      }
      await tx.insert(schema.members).values({ groupId: g.id, userId, name: m.name, phone, color: PALETTE[i++ % PALETTE.length] });
    }
    return g;
  });

  await postMessage({ groupId: group.id, kind: "system", body: `${user.name} created “${group.name}”.` });
  await postMessage({
    groupId: group.id,
    kind: "bot_text",
    body: `Hi! I'm SplitBot. Tag me with what you paid and I'll propose a split for the group to confirm — e.g. “@splitbot dinner 2400, Riya didn't come”. Share the invite link from the group info so everyone can join.`,
    data: { help: true },
  });
  return json({ id: group.id });
});

