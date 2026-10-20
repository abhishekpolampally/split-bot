import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageView } from "./types";

/** The in-memory chat store the page renders from, and how it reads and writes the device cache. */

type Store = typeof import("./chatStore");
type Cache = typeof import("./chatCache");
let store: Store;
let cache: Cache;
const reload = vi.fn();
let signedIn = "u1";

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  reload.mockReset();
  signedIn = "u1";
  vi.stubGlobal("window", { location: { reload } });
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ user: { id: signedIn } }), { status: 200 }));
  cache = await import("./chatCache");
  store = await import("./chatStore");
});
afterEach(() => vi.unstubAllGlobals());

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
const cursor = (after: number) => ({ after, since: "2026-10-20T00:00:00.000Z" });
/** Let fire-and-forget writes and the background owner check finish. */
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("chat store", () => {
  it("a chat never opened starts empty, from the beginning", async () => {
    await store.hydrateChat("g1");
    expect(store.getChat("g1")).toMatchObject({ hydrated: true, info: null, cursor: { after: 0, since: "" } });
    expect(store.getChat("g1")!.messages.size).toBe(0);
  });

  it("a chat opened before comes back from the device, with its cursor", async () => {
    await store.claimChatCache("u1");
    await cache.saveMessages("g1", [msg(1), msg(2)], cursor(2));
    await store.hydrateChat("g1");
    const chat = store.getChat("g1")!;
    expect([...chat.messages.keys()]).toEqual([1, 2]);
    expect(chat.cursor).toEqual(cursor(2));
  });

  it("polls write through to the device", async () => {
    await store.claimChatCache("u1");
    await store.hydrateChat("g1");
    store.applyPoll("g1", [msg(1), msg(2)], cursor(2));
    store.applyPoll("g1", [msg(2, "confirmed")], cursor(2));
    await settle();
    const saved = await cache.loadGroup("g1");
    expect(saved!.messages.map((m) => m.body)).toEqual(["message 1", "confirmed"]);
    expect(store.getChat("g1")!.messages.get(2)!.body).toBe("confirmed");
  });

  it("listeners hear about changes", async () => {
    const heard = vi.fn();
    const stop = store.subscribeChat("g1", heard);
    await store.hydrateChat("g1");
    store.applyPoll("g1", [msg(1)], cursor(1));
    stop();
    store.applyPoll("g1", [msg(2)], cursor(2));
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("resetChat starts the group over, in memory and on disk", async () => {
    await store.claimChatCache("u1");
    await store.hydrateChat("g1");
    store.applyPoll("g1", [msg(1)], cursor(1));
    await settle();
    await store.resetChat("g1");
    expect(store.getChat("g1")).toMatchObject({ cursor: { after: 0, since: "" } });
    expect(await cache.loadGroup("g1")).toBeNull();
  });

  it("dropChat (removed from the group) forgets its info and messages", async () => {
    await store.hydrateChat("g1");
    store.setChatInfo("g1", { group: { id: "g1", name: "Goa", color: "#0a0", inviteToken: "t" }, meId: "m1", members: [] });
    store.applyPoll("g1", [msg(1)], cursor(1));
    store.dropChat("g1");
    await settle();
    expect(store.getChat("g1")!.info).toBeNull();
    expect(await cache.loadGroup("g1")).toBeNull();
  });
});

describe("whose cache it is", () => {
  it("signing in as someone else wipes the last person's chats", async () => {
    await store.claimChatCache("u1");
    await cache.saveMessages("g1", [msg(1)], cursor(1));
    await store.claimChatCache("u2");
    await store.hydrateChat("g1");
    expect(store.getChat("g1")!.messages.size).toBe(0);
  });

  it("logout wipes everything", async () => {
    await store.claimChatCache("u1");
    await store.hydrateChat("g1");
    store.applyPoll("g1", [msg(1)], cursor(1));
    await settle();
    await store.clearChatCache();
    expect(store.getChat("g1")).toBeUndefined();
    expect(await cache.cacheOwner()).toBeNull();
    expect(await cache.loadGroup("g1")).toBeNull();
  });

  it("backstop: a session for a different user than the cache's owner wipes it and reloads", async () => {
    await cache.openCache("u1");
    await cache.saveMessages("g1", [msg(1)], cursor(1));
    signedIn = "u2";
    await store.hydrateChat("g1");
    await settle();
    expect(reload).toHaveBeenCalled();
    expect(await cache.loadGroup("g1")).toBeNull();
  });

  it("an unclaimed cache is claimed for whoever is signed in", async () => {
    await store.hydrateChat("g1");
    await settle();
    expect(await cache.cacheOwner()).toBe("u1");
    expect(reload).not.toHaveBeenCalled();
  });
});
