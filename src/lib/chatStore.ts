import * as cache from "@/lib/chatCache";
import type { ChatCursor, GroupInfo } from "@/lib/chatCache";
import type { MemberView, MessageView } from "@/lib/types";

/**
 * What the chat page renders from: an in-memory copy of each open group's messages, info and
 * poll cursor, read synchronously through useSyncExternalStore. IndexedDB (chatCache) sits behind
 * it, so coming back to a chat, even after a reload or an app restart, shows it straight away and
 * the next poll only asks for what changed.
 */

export interface ChatState {
  info: GroupInfo | null;
  messages: Map<number, MessageView>;
  cursor: ChatCursor;
  /** The saved copy (if any) has been read, so polling can start from its cursor. */
  hydrated: boolean;
}

const START: ChatCursor = { after: 0, since: "" };
const chats = new Map<string, ChatState>();
const listeners = new Map<string, Set<() => void>>();

function update(groupId: string, patch: Partial<ChatState>) {
  const prev = chats.get(groupId) ?? { info: null, messages: new Map(), cursor: START, hydrated: false };
  chats.set(groupId, { ...prev, ...patch });
  for (const fn of listeners.get(groupId) ?? []) fn();
}

export function subscribeChat(groupId: string, fn: () => void) {
  const set = listeners.get(groupId) ?? new Set();
  listeners.set(groupId, set);
  set.add(fn);
  return () => void set.delete(fn);
}

export const getChat = (groupId: string): ChatState | undefined => chats.get(groupId);

// Tidy old groups once per app start.
let tidied = false;

// The user the cache was last confirmed for, so each poll's check is a string compare.
let confirmedUser: string | null = null;

/**
 * Every group-info and poll response says who is signed in. The first time (and if it ever
 * changes), make sure the cache is theirs: if it holds someone else's chats, the whole database is
 * deleted and the page starts over. Returns false then, and the response shouldn't be used.
 */
export async function checkUser(userId: string): Promise<boolean> {
  if (userId === confirmedUser) return true;
  const kept = await cache.openCache(userId);
  confirmedUser = userId;
  if (kept) return true;
  chats.clear();
  // Someone else's chats may be on screen: start this page over without them.
  window.location.reload();
  return false;
}

/** Load the saved copy of a group into memory (once per app start), then polling can begin. */
export async function hydrateChat(groupId: string) {
  if (chats.get(groupId)?.hydrated) return;
  if (!tidied) {
    tidied = true;
    void cache.evictStale();
  }
  const saved = await cache.loadGroup(groupId);
  const current = chats.get(groupId);
  update(groupId, {
    info: current?.info ?? saved?.record.info ?? null,
    messages: new Map([...(saved?.messages ?? []).map((m) => [m.id, m] as const), ...(current?.messages ?? [])]),
    cursor: saved?.record.cursor ?? current?.cursor ?? START,
    hydrated: true,
  });
}

/** Merge a poll's messages and move the cursor, in memory and on disk. */
export function applyPoll(groupId: string, messages: MessageView[], cursor: ChatCursor, hasMore?: boolean) {
  const prev = chats.get(groupId)?.messages ?? new Map();
  let next = prev;
  if (messages.length) {
    next = new Map(prev);
    for (const m of messages) next.set(m.id, m);
    // Same cap as the disk copy, so memory doesn't outgrow it on a long session.
    if (next.size > cache.MAX_MESSAGES_PER_GROUP) {
      const keep = [...next.keys()].sort((a, b) => a - b).slice(-cache.MAX_MESSAGES_PER_GROUP);
      next = new Map(keep.map((id) => [id, next.get(id)!]));
    }
  }
  update(groupId, { messages: next, cursor });
  void cache.saveMessages(groupId, messages, cursor, hasMore);
}

export function setChatInfo(groupId: string, info: GroupInfo) {
  update(groupId, { info });
  void cache.saveInfo(groupId, info);
}

export function setChatMembers(groupId: string, members: MemberView[]) {
  const info = chats.get(groupId)?.info;
  if (info) setChatInfo(groupId, { ...info, members });
}

/** Start the group over from an empty cache; the next poll loads the latest page. */
export async function resetChat(groupId: string) {
  update(groupId, { messages: new Map(), cursor: START });
  await cache.dropGroup(groupId);
}

/** Removed from the group, or it's gone: forget it entirely. */
export function dropChat(groupId: string) {
  update(groupId, { info: null, messages: new Map(), cursor: START });
  void cache.dropGroup(groupId);
}

/** After sign-in: the cache now belongs to `userId` (anyone else's is deleted). */
export async function claimChatCache(userId: string) {
  chats.clear();
  await cache.openCache(userId);
  confirmedUser = userId;
}

/** Logout: nothing of this account stays on the device. */
export async function clearChatCache() {
  chats.clear();
  confirmedUser = null;
  await cache.clearAll();
}
