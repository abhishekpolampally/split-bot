import "server-only";
import { waitUntil } from "@vercel/functions";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db, schema } from "@/db";
import { firebaseMessaging } from "./firebase";

interface Notice {
  /** Defaults to the group's name. */
  title?: string;
  body: string;
  /** Where tapping the notification opens. */
  url: string;
  /** Notifications with the same tag replace each other (one per group, not one per message). */
  tag?: string;
}

/**
 * Push a notification to members of a group: either everyone except `exceptMemberId`, or just
 * `memberIds`. Runs after the response is sent; a no-op when push isn't configured.
 */
export function notifyGroup(groupId: string, to: { exceptMemberId?: string | null; memberIds?: string[] }, notice: Notice) {
  if (!firebaseMessaging()) return;
  waitUntil(send(groupId, to, notice).catch((e) => console.error("[push] send failed:", (e as Error).message)));
}

async function send(groupId: string, to: { exceptMemberId?: string | null; memberIds?: string[] }, notice: Notice) {
  const messaging = firebaseMessaging();
  if (!messaging) return;
  if (to.memberIds && !to.memberIds.length) return;
  const rows = await db
    .select({ token: schema.pushTokens.token })
    .from(schema.pushTokens)
    .innerJoin(schema.members, eq(schema.members.userId, schema.pushTokens.userId))
    .where(
      and(
        eq(schema.members.groupId, groupId),
        to.memberIds ? inArray(schema.members.id, to.memberIds) : undefined,
        to.exceptMemberId ? ne(schema.members.id, to.exceptMemberId) : undefined,
      ),
    );
  const tokens = [...new Set(rows.map((r) => r.token))];
  if (!tokens.length) return;
  let title = notice.title;
  if (!title) {
    const [g] = await db.select({ name: schema.groups.name }).from(schema.groups).where(eq(schema.groups.id, groupId));
    title = g?.name ?? "SplitBot";
  }
  const dead: string[] = [];
  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens.slice(i, i + 500);
    // Data-only message: public/sw.js shows it, so the look is the same on every browser.
    const res = await messaging.sendEachForMulticast({
      tokens: batch,
      data: { title, body: notice.body.slice(0, 180), url: notice.url, tag: notice.tag ?? "" },
      webpush: { headers: { Urgency: "high", TTL: String(24 * 3600) } },
    });
    res.responses.forEach((r, j) => {
      const code = r.error?.code ?? "";
      if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") dead.push(batch[j]);
    });
  }
  if (dead.length) await db.delete(schema.pushTokens).where(inArray(schema.pushTokens.token, dead));
}
