import { getApps, initializeApp, type FirebaseApp } from "firebase/app";

/** Public web config from Firebase console → Project settings → Your apps (safe to ship to browsers). */
const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

// NEXT_PUBLIC_ values are baked in when the app is built, so a deployment only sees variables
// that existed on Vercel before its build started.
const required = {
  NEXT_PUBLIC_FIREBASE_API_KEY: config.apiKey,
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: config.authDomain,
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: config.projectId,
  NEXT_PUBLIC_FIREBASE_APP_ID: config.appId,
};
/** Names (never values) of the settings this build is missing, for the login screen. */
export const missingFirebaseConfig = Object.entries(required)
  .filter(([, v]) => !v)
  .map(([k]) => k);
export const firebaseConfigured = missingFirebaseConfig.length === 0;

export function firebaseApp(): FirebaseApp {
  return getApps()[0] ?? initializeApp(config);
}
