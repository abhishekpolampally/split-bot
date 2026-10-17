export const PALETTE = ["#0F7B5F", "#B4532A", "#6B4FBB", "#1F6FB2", "#A4471C", "#2F6B5C", "#8A5A00", "#B23A6F", "#3D6E1E", "#5B5F97"];

export function pickColor(seed: string | number) {
  const n = typeof seed === "number" ? seed : [...seed].reduce((a, c) => a + c.charCodeAt(0), 0);
  return PALETTE[Math.abs(n) % PALETTE.length];
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, parts[0].length > 2 ? 1 : 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
