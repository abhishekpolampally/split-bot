import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupInfo } from "./chatCache";
import type { MessageView } from "./types";

/** The IndexedDB chat cache, against an in-memory IndexedDB that starts empty for every test. */

type Cache = typeof import("./chatCache");
let cache: Cache;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  vi.doUnmock("idb");
  cache = await import("./chatCache");
});

const msg = (id: number, body = `message ${id}`): MessageView => ({
  id,
  kind: "text",
  body,
  data: null,
  senderMemberId: "m1",
  replyToId: null,
  createdAt: new Date(1_700_000_000_000 + id * 1000).toISOString(),
  proposal: null,
});
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => msg(from + i));
const cursor = (after: number) => ({ after, since: "2026-10-20T00:00:00.000Z" });
const info: GroupInfo = { group: { id: "g1", name: "Goa", color: "#0a0", inviteToken: "t" }, meId: "m1", members: [] };
const ids = async (groupId: string) => (await cache.loadGroup(groupId))?.messages.map((m) => m.id);

describe("messages", () => {
  it("upserts by id, so a changed card replaces the old copy", async () => {
    await cache.saveMessages("g1", [msg(1), msg(2)], cursor(2));
    await cache.saveMessages("g1", [msg(2, "edited"), msg(3)], cursor(3));
    const saved = await cache.loadGroup("g1");
    expect(saved!.messages).toEqual([msg(1), msg(2, "edited"), msg(3)]);
    expect(saved!.record.cursor).toEqual(cursor(3));
  });

  it("keeps groups apart", async () => {
    await cache.saveMessages("g1", [msg(1), msg(3)], cursor(3));
    await cache.saveMessages("g2", [msg(2), msg(4)], cursor(4));
    expect(await ids("g1")).toEqual([1, 3]);
    expect(await ids("g2")).toEqual([2, 4]);
  });

  it("an unknown group has nothing saved", async () => {
    expect(await cache.loadGroup("nope")).toBeNull();
  });

  it("keeps only the newest messages per group, and remembers there's older history", async () => {
    await cache.saveMessages("g1", range(1, 600), cursor(600), false);
    expect((await cache.loadGroup("g1"))!.record).toMatchObject({ oldestId: 1, hasMore: false });
    await cache.saveMessages("g1", range(601, 1005), cursor(1005));
    const saved = await cache.loadGroup("g1");
    expect(saved!.messages).toHaveLength(cache.MAX_MESSAGES_PER_GROUP);
    expect(saved!.messages[0].id).toBe(6);
    expect(saved!.record).toMatchObject({ oldestId: 6, hasMore: true });
  });

  it("saving info keeps the cursor, and saving messages keeps the info", async () => {
    await cache.saveMessages("g1", [msg(1)], cursor(1));
    await cache.saveInfo("g1", info);
    await cache.saveMessages("g1", [msg(2)], cursor(2));
    expect((await cache.loadGroup("g1"))!.record).toMatchObject({ info, cursor: cursor(2) });
  });

  it("dropGroup forgets one group only", async () => {
    await cache.saveMessages("g1", [msg(1)], cursor(1));
    await cache.saveMessages("g2", [msg(2)], cursor(2));
    await cache.dropGroup("g1");
    expect(await cache.loadGroup("g1")).toBeNull();
    expect(await ids("g2")).toEqual([2]);
  });
});

describe("eviction", () => {
  it("drops groups not opened for 30 days", async () => {
    const t0 = Date.now();
    await cache.saveMessages("old", [msg(1)], cursor(1));
    vi.spyOn(Date, "now").mockReturnValue(t0 + 10 * 24 * 60 * 60 * 1000);
    await cache.saveMessages("new", [msg(2)], cursor(2));
    vi.restoreAllMocks();

    await cache.evictStale(t0 + cache.STALE_AFTER_MS - 1000);
    expect(await ids("old")).toEqual([1]);
    await cache.evictStale(t0 + cache.STALE_AFTER_MS + 1000);
    expect(await cache.loadGroup("old")).toBeNull();
    expect(await ids("new")).toEqual([2]);
  });

  it("opening a group keeps it fresh", async () => {
    await cache.saveMessages("g1", [msg(1)], cursor(1));
    const t0 = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(t0 + cache.STALE_AFTER_MS - 1000);
    await cache.loadGroup("g1");
    vi.restoreAllMocks();
    await cache.evictStale(t0 + cache.STALE_AFTER_MS + 1000);
    expect(await ids("g1")).toEqual([1]);
  });
});

describe("who the cache belongs to", () => {
  it("the first sign-in claims it without losing anything", async () => {
    await cache.saveMessages("g1", [msg(1)], cursor(1));
    await cache.openCache("u1");
    expect(await cache.cacheOwner()).toBe("u1");
    expect(await ids("g1")).toEqual([1]);
  });

  it("the same user again keeps it", async () => {
    await cache.openCache("u1");
    await cache.saveMessages("g1", [msg(1)], cursor(1));
    await cache.openCache("u1");
    expect(await ids("g1")).toEqual([1]);
  });

  it("a different user wipes it first", async () => {
    await cache.openCache("u1");
    await cache.saveMessages("g1", [msg(1)], cursor(1));
    await cache.saveInfo("g1", info);
    await cache.openCache("u2");
    expect(await cache.cacheOwner()).toBe("u2");
    expect(await cache.loadGroup("g1")).toBeNull();
  });

  it("clearAll (logout) wipes everything, owner included", async () => {
    await cache.openCache("u1");
    await cache.saveMessages("g1", [msg(1)], cursor(1));
    await cache.clearAll();
    expect(await cache.cacheOwner()).toBeNull();
    expect(await cache.loadGroup("g1")).toBeNull();
  });
});

describe("versions", () => {
  it("bumping CACHE_VERSION wipes the old data", async () => {
    await cache.openCache("u1");
    await cache.saveMessages("g1", [msg(1)], cursor(1));
    // Load the module again as a build one version newer, on the same IndexedDB.
    vi.resetModules();
    vi.doMock("idb", async (orig) => {
      const idb = await orig<typeof import("idb")>();
      return { ...idb, openDB: (name: string, version: number, cbs: object) => idb.openDB(name, version + 1, cbs) };
    });
    const newer: Cache = await import("./chatCache");
    expect(await newer.loadGroup("g1")).toBeNull();
    expect(await newer.cacheOwner()).toBeNull();
  });

  it("a copy left by a newer build (after a rollback) is wiped too", async () => {
    const { openDB } = await import("idb");
    const db = await openDB("splitbot", 99, { upgrade: (d) => void d.createObjectStore("junk") });
    db.close();
    await cache.saveMessages("g1", [msg(1)], cursor(1));
    expect(await ids("g1")).toEqual([1]);
  });
});

describe("without IndexedDB", () => {
  it("every call fails soft", async () => {
    // @ts-expect-error: private mode, or a browser without it
    delete globalThis.indexedDB;
    vi.resetModules();
    const none: Cache = await import("./chatCache");
    await expect(none.openCache("u1")).resolves.toBeUndefined();
    await expect(none.saveMessages("g1", [msg(1)], cursor(1))).resolves.toBeUndefined();
    await expect(none.loadGroup("g1")).resolves.toBeNull();
    await expect(none.cacheOwner()).resolves.toBeNull();
    await expect(none.clearAll()).resolves.toBeUndefined();
  });

  it("a broken IndexedDB fails soft too", async () => {
    globalThis.indexedDB = { open: () => { throw new Error("blocked"); } } as unknown as IDBFactory;
    vi.resetModules();
    const broken: Cache = await import("./chatCache");
    await expect(broken.saveMessages("g1", [msg(1)], cursor(1))).resolves.toBeUndefined();
    await expect(broken.loadGroup("g1")).resolves.toBeNull();
  });
});
