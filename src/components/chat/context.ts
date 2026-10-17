"use client";

import { createContext, useContext } from "react";
import type { MemberView } from "@/lib/types";

export interface ChatCtx {
  groupId: string;
  groupName: string;
  meId: string;
  members: MemberView[];
  member: (id: string | null | undefined) => MemberView | undefined;
  /** "You" for me, the member's name otherwise. */
  display: (id: string | null | undefined) => string;
  refresh: () => void;
  openEdit: (proposalId: string) => void;
  replyTo: (messageId: number, prefill?: string) => void;
}

export const ChatContext = createContext<ChatCtx | null>(null);
export function useChat() {
  const c = useContext(ChatContext);
  if (!c) throw new Error("ChatContext missing");
  return c;
}
