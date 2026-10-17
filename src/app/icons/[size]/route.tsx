import { renderIcon } from "@/lib/icon";

export async function GET(_req: Request, ctx: { params: Promise<{ size: string }> }) {
  const { size } = await ctx.params;
  if (size === "maskable") return renderIcon(512, 96);
  const n = Math.min(1024, Math.max(16, Number(size) || 192));
  return renderIcon(n);
}
