"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { startObservability } from "@/lib/firebase/analytics";
import { refreshPush } from "@/lib/firebase/push";

/** Registers the service worker and starts Firebase Analytics, Performance and push refresh. */
export function ServiceWorker() {
  const pathname = usePathname();
  const signedOut = pathname === "/login" || pathname.startsWith("/login/");

  useEffect(() => {
    startObservability();
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production" && !process.env.NEXT_PUBLIC_SW_DEV) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!signedOut) void refreshPush().catch(() => {});
  }, [signedOut]);

  return null;
}
