import { firebaseApp, firebaseConfigured } from "./client";

/**
 * Web push via Firebase Cloud Messaging, delivered to our own service worker (public/sw.js).
 * iPhones only allow push for apps added to the Home Screen (iOS 16.4+).
 */
export type PushState = "unsupported" | "needs-install" | "off" | "on" | "blocked";

const VAPID_KEY = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY;
const STORED = "sb_push_token";

function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}
function standalone() {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

export async function pushState(): Promise<PushState> {
  if (!firebaseConfigured || !VAPID_KEY || !("serviceWorker" in navigator)) return "unsupported";
  if (!("Notification" in window) || !("PushManager" in window)) return isIos() && !standalone() ? "needs-install" : "unsupported";
  const { isSupported } = await import("firebase/messaging");
  if (!(await isSupported())) return "unsupported";
  // The service worker is only registered in production builds (see ServiceWorker.tsx).
  if (!(await navigator.serviceWorker.getRegistration("/"))) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  return Notification.permission === "granted" && storedToken() ? "on" : "off";
}

function storedToken() {
  try {
    return localStorage.getItem(STORED);
  } catch {
    return null;
  }
}

async function currentToken() {
  const reg = await navigator.serviceWorker.ready;
  const { getMessaging, getToken } = await import("firebase/messaging");
  return getToken(getMessaging(firebaseApp()), { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
}

async function save(token: string) {
  const res = await fetch("/api/push/tokens", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  if (!res.ok) throw new Error("Couldn't save this device for notifications.");
  try {
    localStorage.setItem(STORED, token);
  } catch {
    /* private mode: we'll re-register next time */
  }
}

/** Ask for permission (must run from a tap) and register this device. */
export async function enablePush(): Promise<boolean> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return false;
  await save(await currentToken());
  return true;
}

export async function disablePush() {
  const token = storedToken();
  try {
    localStorage.removeItem(STORED);
  } catch {
    /* ignore */
  }
  if (!token) return;
  await fetch("/api/push/tokens", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) }).catch(() => {});
  const { deleteToken, getMessaging } = await import("firebase/messaging");
  await deleteToken(getMessaging(firebaseApp())).catch(() => {});
}

/** FCM tokens rotate; re-send it quietly on app start when notifications are already on. */
export async function refreshPush() {
  if ((await pushState()) !== "on") return;
  const token = await currentToken();
  if (token) await save(token);
}
