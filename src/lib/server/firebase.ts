import "server-only";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { createRemoteJWKSet, jwtVerify } from "jose";

const projectId = () => process.env.FIREBASE_PROJECT_ID ?? process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

/**
 * Firebase Admin, used only for push notifications, which need a service account
 * (FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY from Project settings → Service accounts →
 * Generate new private key).
 */
function app(): App | null {
  const existing = getApps()[0];
  if (existing) return existing;
  const id = projectId();
  if (!id) return null;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  // Env UIs store the key on one line with literal "\n"s.
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  return initializeApp(clientEmail && privateKey ? { projectId: id, credential: cert({ projectId: id, clientEmail, privateKey }) } : { projectId: id });
}

/** Null when no service account is configured; push notifications are then skipped. */
export function firebaseMessaging() {
  const a = app();
  return a && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY ? getMessaging(a) : null;
}

// Google's signing keys for Firebase ID tokens; jose caches them and refetches when they rotate.
const firebaseKeys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"),
);

export type FirebaseIdToken = {
  uid: string;
  authTime: number;
  phoneNumber?: string;
  signInProvider?: string;
};

/**
 * Verify a Firebase ID token the way Firebase documents for third-party JWT libraries. Done with
 * jose rather than firebase-admin/auth, whose jwks-rsa dependency require()s the ESM-only jose and
 * crashes on Vercel. Returns null when login isn't configured; throws when the token is invalid.
 */
export async function verifyFirebaseIdToken(idToken: string): Promise<FirebaseIdToken | null> {
  const id = projectId();
  if (!id) return null;
  const { payload } = await jwtVerify(idToken, firebaseKeys, {
    algorithms: ["RS256"],
    issuer: `https://securetoken.google.com/${id}`,
    audience: id,
    requiredClaims: ["sub", "auth_time", "iat", "exp"],
  });
  const authTime = payload.auth_time as number;
  if (!payload.sub || typeof authTime !== "number" || authTime > Date.now() / 1000 + 60) throw new Error("Bad ID token claims");
  const firebase = payload.firebase as { sign_in_provider?: string } | undefined;
  return {
    uid: payload.sub,
    authTime,
    phoneNumber: payload.phone_number as string | undefined,
    signInProvider: firebase?.sign_in_provider,
  };
}
