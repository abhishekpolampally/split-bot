"use client";

import { useApi } from "@/lib/client";
import type { MemberView, Transfer } from "@/lib/types";

export interface BalancesData {
  group: { id: string; name: string };
  meId: string;
  members: MemberView[];
  net: Record<string, number>;
  transfers: Transfer[];
  totalSpendPaise: number;
  activity: (
    | {
        type: "expense";
        id: string;
        title: string;
        category: string;
        payerMemberId: string;
        totalPaise: number;
        myShare: number;
        shares: Record<string, number>;
        at: string;
      }
    | { type: "settlement"; id: string; from: string; to: string; amountPaise: number; method: string; at: string }
  )[];
}

export function useBalances(groupId: string) {
  const r = useApi<BalancesData>(`/api/groups/${groupId}/balances`, 5000);
  const d = r.data;
  const name = (id: string) => (id === d?.meId ? "You" : (d?.members.find((m) => m.id === id)?.name ?? "Someone"));
  const member = (id: string) => d?.members.find((m) => m.id === id);
  return { ...r, name, member };
}
