import { NextResponse, type NextRequest } from "next/server";

const PUBLIC = ["/login", "/offline"];

/** Cheap gate: bounce visitors without a session cookie to /login. APIs validate sessions themselves. */
export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(p + "/"))) return NextResponse.next();
  if (req.cookies.has("sb_session")) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!api|_next|icons|icon|apple-icon|manifest.webmanifest|sw.js|favicon).*)"],
};
