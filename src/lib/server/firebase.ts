import "server-only";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getMessaging } from "firebase-admin/messaging";

/**
 * Firebase Admin. Verifying login tokens only needs the project id (Google's public keys do
 * the rest); sending push notifications needs a service account (FIREBASE_CLIENT_EMAIL and
 * FIREBASE_PRIVATE_KEY from Project settings → Service accounts → Generate new private key).
 */
function app(): App | null {
  const existing = getApps()[0];
  if (existing) return existing;
  const projectId = process.env.FIREBASE_PROJECT_ID ?? process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (!projectId) return null;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  // Env UIs store the key on one line with literal "\n"s.
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  return initializeApp(clientEmail && privateKey ? { projectId, credential: cert({ projectId, clientEmail, privateKey }) } : { projectId });
}

export function firebaseAuth() {
  const a = app();
  return a ? getAuth(a) : null;
}

/** Null when no service account is configured; push notifications are then skipped. */
export function firebaseMessaging() {
  const a = app();
  return a && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY ? getMessaging(a) : null;
}
