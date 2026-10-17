import { ImageResponse } from "next/og";

/** The SplitBot mark from the prototype: a green disc with a "%"-style split glyph. */
export function renderIcon(size: number, padding = 0) {
  const inner = size - padding * 2;
  return new ImageResponse(
    (
      <div style={{ width: size, height: size, display: "flex", alignItems: "center", justifyContent: "center", background: padding ? "#0F7B5F" : "transparent" }}>
        <svg width={inner} height={inner} viewBox="0 0 28 28">
          <circle cx="14" cy="14" r="14" fill="#0F7B5F" />
          <path d="M9.5 18.5l9-9" stroke="#FFFFFF" strokeWidth={2} strokeLinecap="round" />
          <circle cx="10" cy="10" r="2.2" fill="#FFFFFF" />
          <circle cx="18" cy="18" r="2.2" fill="#FFFFFF" />
        </svg>
      </div>
    ),
    { width: size, height: size, headers: { "Cache-Control": "public, max-age=86400" } },
  );
}
