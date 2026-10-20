import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { MemberView, MessageView } from "@/lib/types";

/**
 * Chat history kept on the device (IndexedDB), so reopening a chat costs one small delta poll
 * instead of a full load of the latest 200 messages. Browser-only. Every call fails soft: if
 * IndexedDB is missing or broken (private mode, quota), reads come back empty, writes are dropped
 * and the chat behaves as it did without a cache.
 *
 * The cache belongs to one user, whose id is kept with the data. Whenever the server says someone
 * else is signed in (`openCache(userId)`), the whole database is deleted and starts over; logout
 * deletes it too.
 */

/** Bump when the shape of what's stored changes; opening with a new version wipes everything. */
export const CACHE_VERSION = 1;
const DB_NAME = "splitbot";
/** Newest messages kept per group. */
export const MAX_MESSAGES_PER_GROUP = 1000;
/** Groups not opened for this long are dropped. */
export const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export interface GroupInfo {
  group: { id: string; name: string; color: string; inviteToken: string };
  meId: string;
  /** The signed-in user the server answered for. */
  userId: string;
  members: MemberView[];
}
export interface ChatCursor {
  after: number;
  since: string;
}
export interface GroupRecord {
  groupId: string;
  info: GroupInfo | null;
  cursor: ChatCursor;
  /** The oldest message id cached, and whether the server has older ones (for paging back). */
  oldestId: number | null;
  hasMore: boolean;
  lastOpenedAt: number;
}
type StoredMessage = MessageView & { groupId: string };

interface CacheSchema extends DBSchema {
  meta: { key: string; value: { key: string; value: string } };
  groups: { key: string; value: GroupRecord };
  messages: { key: number; value: StoredMessage; indexes: { byGroup: [string, number] } };
}
type DB = IDBPDatabase<CacheSchema>;

let dbPromise: Promise<DB | null> | null = null;

function connect(): Promise<DB | null> {
  dbPromise ??= (async () => {
    if (typeof indexedDB === "undefined") return null;
    const open = () =>
      openDB<CacheSchema>(DB_NAME, CACHE_VERSION, {
        // Any version change starts clean: old rows may not match the new shape.
        upgrade(db) {
          for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name);
          db.createObjectStore("meta", { keyPath: "key" });
          db.createObjectStore("groups", { keyPath: "groupId" });
          db.createObjectStore("messages", { keyPath: "id" }).createIndex("byGroup", ["groupId", "id"]);
        },
        // Another tab is on a newer CACHE_VERSION: let it take over.
        blocking() {
          void dbPromise?.then((db) => db?.close());
          dbPromise = null;
        },
      });
    try {
      return await open();
    } catch (e) {
      // A newer build left a higher version behind (e.g. after a rollback): start over.
      if ((e as Error).name !== "VersionError") return null;
      try {
        await deleteDB(DB_NAME);
        return await open();
      } catch {
        return null;
      }
    }
  })();
  return dbPromise;
}

/** Run against the database, or return `fallback` when there's none or the call fails. */
async function withDb<T>(fallback: T, fn: (db: DB) => Promise<T>): Promise<T> {
  const db = await connect();
  if (!db) return fallback;
  try {
    return await fn(db);
  } catch {
    return fallback;
  }
}

const groupRange = (groupId: string, below = Infinity) => IDBKeyRange.bound([groupId, -Infinity], [groupId, below], false, true);

/** The user this cache belongs to, or null when nobody has claimed it yet. */
export function cacheOwner(): Promise<string | null> {
  return withDb(null, async (db) => (await db.get("meta", "owner"))?.value ?? null);
}

/**
 * Claim the cache for `userId`. If it holds someone else's chats, delete the whole database first.
 * Returns false when it did (so anything already read from it should go too).
 */
export async function openCache(userId: string): Promise<boolean> {
  const owner = await cacheOwner();
  if (owner === userId) return true;
  // No owner means nothing was left by anyone else (clearAll removes the owner with the data).
  if (owner) await clearAll();
  await withDb(undefined, async (db) => {
    await db.put("meta", { key: "owner", value: userId });
  });
  return !owner;
}

export async function loadGroup(groupId: string): Promise<{ record: GroupRecord; messages: MessageView[] } | null> {
  return withDb(null, async (db) => {
    const tx = db.transaction(["groups", "messages"], "readwrite");
    const record = await tx.objectStore("groups").get(groupId);
    if (!record) return null;
    const rows = await tx.objectStore("messages").index("byGroup").getAll(groupRange(groupId));
    await tx.objectStore("groups").put({ ...record, lastOpenedAt: Date.now() });
    await tx.done;
    return {
      record,
      messages: rows.map((row) => {
        const m: MessageView & { groupId?: string } = { ...row };
        delete m.groupId;
        return m;
      }),
    };
  });
}

/**
 * Upsert messages by id and move the cursor, in one transaction, then trim the group to its
 * newest MAX_MESSAGES_PER_GROUP. `hasMore` is only changed when given.
 */
export async function saveMessages(groupId: string, messages: MessageView[], cursor: ChatCursor, hasMore?: boolean): Promise<void> {
  const write = (db: DB) => writeMessages(db, groupId, messages, cursor, hasMore);
  const saved = await withDb(false, async (db) => {
    try {
      await write(db);
    } catch (e) {
      if ((e as Error).name !== "QuotaExceededError") throw e;
      // Out of space: drop the least recently opened other group and try once more.
      const others = (await db.getAll("groups")).filter((g) => g.groupId !== groupId).sort((a, b) => a.lastOpenedAt - b.lastOpenedAt);
      if (!others.length) throw e;
      await dropGroup(others[0].groupId);
      await write(db);
    }
    return true;
  });
  // A lost write would leave a gap before the next saved cursor; start this group over instead.
  if (!saved) await dropGroup(groupId);
}

async function writeMessages(db: DB, groupId: string, messages: MessageView[], cursor: ChatCursor, hasMore?: boolean) {
  const tx = db.transaction(["groups", "messages"], "readwrite");
  const groups = tx.objectStore("groups");
  const store = tx.objectStore("messages");
  const prev = await groups.get(groupId);
  for (const m of messages) await store.put({ ...m, groupId });

  // Trim the oldest beyond the cap.
  const keys = await store.index("byGroup").getAllKeys(groupRange(groupId));
  const extra = keys.length - MAX_MESSAGES_PER_GROUP;
  for (const id of keys.slice(0, Math.max(0, extra))) await store.delete(id);

  const oldestId = (keys[Math.max(0, extra)] as number | undefined) ?? null;
  await groups.put({
    groupId,
    info: prev?.info ?? null,
    cursor,
    oldestId,
    hasMore: extra > 0 || (hasMore ?? prev?.hasMore ?? true),
    lastOpenedAt: Date.now(),
  });
  await tx.done;
}

export async function saveInfo(groupId: string, info: GroupInfo): Promise<void> {
  await withDb(undefined, async (db) => {
    const tx = db.transaction("groups", "readwrite");
    const prev = await tx.store.get(groupId);
    await tx.store.put({
      groupId,
      info,
      cursor: prev?.cursor ?? { after: 0, since: "" },
      oldestId: prev?.oldestId ?? null,
      hasMore: prev?.hasMore ?? true,
      lastOpenedAt: Date.now(),
    });
    await tx.done;
  });
}

/** Forget one group: removed from it, it was deleted, or its cache fell too far behind. */
export async function dropGroup(groupId: string): Promise<void> {
  await withDb(undefined, async (db) => {
    const tx = db.transaction(["groups", "messages"], "readwrite");
    await tx.objectStore("groups").delete(groupId);
    await tx.objectStore("messages").delete(groupRange(groupId));
    await tx.done;
  });
}

/** Delete the whole database, owner included (logout, or a different user). The next call starts a fresh one. */
export async function clearAll(): Promise<void> {
  const open = dbPromise;
  dbPromise = null;
  (await open)?.close();
  if (typeof indexedDB === "undefined") return;
  try {
    await deleteDB(DB_NAME);
  } catch {
    // Nothing more to do; the owner check runs again on the next response.
  }
}

/** Drop groups nobody has opened for STALE_AFTER_MS. Run once per app start. */
export async function evictStale(now = Date.now()): Promise<void> {
  const stale = await withDb<string[]>([], async (db) =>
    (await db.getAll("groups")).filter((g) => now - g.lastOpenedAt > STALE_AFTER_MS).map((g) => g.groupId),
  );
  for (const id of stale) await dropGroup(id);
}
