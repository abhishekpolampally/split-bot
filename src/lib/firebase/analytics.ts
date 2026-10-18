import type { Analytics } from "firebase/analytics";
import { firebaseApp, firebaseConfigured } from "./client";

/**
 * Firebase Analytics (Google Analytics 4) and Performance Monitoring. Page views are logged
 * automatically, including client-side navigations; `track` adds the app's own events.
 * Never put phone numbers, names or message text in event params.
 */
export interface AppEvents {
  login: { method: "phone"; new_user: boolean };
  group_create: { members: number };
  member_add: { via: "contacts" | "number"; on_splitbot: boolean };
  invite_share: { via: "share" | "copy" | "whatsapp" };
  invite_join: { claimed: boolean };
  bot_request: { edit: boolean };
  expense_confirm: { rule: string; members: number };
  settle_record: { method: "upi" | "cash" };
  reminder_send: Record<string, never>;
  push_enable: { granted: boolean };
}

let analytics: Promise<Analytics | null> | null = null;
let started = false;

/** Start Analytics and Performance Monitoring once, in the browser. */
export function startObservability() {
  if (started || typeof window === "undefined" || !firebaseConfigured) return;
  started = true;
  analytics = (async () => {
    const { getAnalytics, isSupported } = await import("firebase/analytics");
    return (await isSupported()) && process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID ? getAnalytics(firebaseApp()) : null;
  })().catch(() => null);
  // Real-user page load timing and API request timing, reported to the Firebase console.
  import("firebase/performance").then(({ getPerformance }) => getPerformance(firebaseApp())).catch(() => {});
}

export function track<K extends keyof AppEvents>(name: K, params: AppEvents[K]) {
  if (!analytics) return;
  void analytics.then(async (a) => {
    if (!a) return;
    const { logEvent } = await import("firebase/analytics");
    // logEvent's overloads type each standard GA event separately; AppEvents already types ours.
    (logEvent as (a: Analytics, name: string, params: object) => void)(a, name, params);
  });
}
