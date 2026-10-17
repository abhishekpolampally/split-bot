import { z } from "zod";
import { formatINR } from "@/lib/money";
import { body, HttpError, json, requireMember, route } from "@/lib/server/http";
import { groupLedger } from "@/lib/server/ledger";
import { postMessage } from "@/lib/server/messages";

type Ctx = { params: Promise<{ id: string }> };

export const POST = route<Ctx>(async (req, ctx) => {
  const { id } = await ctx.params;
  const { group, me } = await requireMember(id);
  const { memberId } = await body(req, z.object({ memberId: z.string() }));
  const ledger = await groupLedger(group.id);
  const t = ledger.transfers.find((x) => x.from === memberId && x.to === me.id);
  if (!t) throw new HttpError(400, "They don't owe you anything right now.");
  const debtor = ledger.members.find((m) => m.id === memberId)!;
  await postMessage({
    groupId: group.id,
    kind: "bot_text",
    body: `Friendly nudge, ${debtor.name}: you owe ${me.name} ${formatINR(t.amountPaise)}. Tap Settle up to pay via UPI.`,
    data: { actions: ["settle"], reminder: true },
  });
  return json({ ok: true });
});
