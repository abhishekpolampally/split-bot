import { z } from "zod";
import { body, json, requireMember, route } from "@/lib/server/http";
import { cancelProposal, confirmProposal, updateProposal } from "@/lib/server/proposals";
import { SpecSchema } from "@/lib/server/specSchema";

type Ctx = { params: Promise<{ id: string; pid: string }> };

export const PATCH = route<Ctx>(async (req, ctx) => {
  const { id, pid } = await ctx.params;
  const { group, me } = await requireMember(id);
  const input = await body(req, z.object({ spec: SpecSchema, version: z.number().int() }));
  await updateProposal(group.id, pid, me, input.spec, input.version);
  return json({ ok: true });
});

export const POST = route<Ctx>(async (req, ctx) => {
  const { id, pid } = await ctx.params;
  const { group, me } = await requireMember(id);
  const { action } = await body(req, z.object({ action: z.enum(["confirm", "cancel"]) }));
  if (action === "confirm") await confirmProposal(group.id, pid, me, group.name);
  else await cancelProposal(group.id, pid, me);
  return json({ ok: true });
});
