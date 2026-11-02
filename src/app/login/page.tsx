"use client";

import type { ConfirmationResult, RecaptchaVerifier } from "firebase/auth";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { BotAvatar, Button, ErrorNote, Field, inputCls } from "@/components/ui";
import { claimChatCache } from "@/lib/chatStore";
import { api } from "@/lib/client";
import { track } from "@/lib/firebase/analytics";
import { firebaseApp, firebaseConfigured, missingFirebaseConfig } from "@/lib/firebase/client";
import { formatPhone, normalisePhone } from "@/lib/phone";

type Step = "phone" | "code" | "profile";

/** Firebase error codes → what to tell the person. */
function friendly(e: unknown): string {
  const code = (e as { code?: string }).code ?? "";
  const messages: Record<string, string> = {
    "auth/invalid-phone-number": "That mobile number doesn't look right.",
    "auth/missing-phone-number": "Enter your mobile number.",
    "auth/too-many-requests": "Too many attempts from this device. Wait a while and try again.",
    "auth/quota-exceeded": "We've hit today's SMS limit. Try again later.",
    "auth/invalid-verification-code": "Wrong code. Check the SMS and try again.",
    "auth/code-expired": "That code has expired. Request a new one.",
    "auth/captcha-check-failed": "The security check failed. Reload the page and try again.",
    "auth/network-request-failed": "No connection. Check your internet and try again.",
    "auth/billing-not-enabled": "SMS login isn't switched on for this app yet.",
    "auth/operation-not-allowed": "SMS login isn't switched on for this app yet.",
    "auth/unauthorized-domain": "This website isn't allowed to sign in yet. Add it under Firebase → Authentication → Settings → Authorized domains.",
  };
  return messages[code] ?? (e as Error).message ?? "Something went wrong.";
}

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/";
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [upi, setUpi] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmation = useRef<ConfirmationResult | null>(null);
  const verifier = useRef<RecaptchaVerifier | null>(null);

  useEffect(() => () => verifier.current?.clear(), []);

  async function go(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  }

  const sendCode = () =>
    go(async () => {
      const e164 = normalisePhone(phone);
      if (!e164) throw new Error("Enter a valid 10-digit mobile number.");
      const { getAuth, RecaptchaVerifier, signInWithPhoneNumber } = await import("firebase/auth");
      const auth = getAuth(firebaseApp());
      auth.useDeviceLanguage();
      // Invisible reCAPTCHA: Firebase only shows a challenge when it suspects a bot.
      verifier.current?.clear();
      verifier.current = new RecaptchaVerifier(auth, "recaptcha", { size: "invisible" });
      try {
        confirmation.current = await signInWithPhoneNumber(auth, e164, verifier.current);
      } catch (e) {
        verifier.current.clear();
        verifier.current = null;
        throw e;
      }
      setSentTo(e164);
      setCode("");
      setStep("code");
    });

  const verify = () =>
    go(async () => {
      if (!confirmation.current) throw new Error("Request a code first.");
      const cred = await confirmation.current.confirm(code);
      const idToken = await cred.user.getIdToken();
      const res = await api<{ isNew: boolean }>("/api/auth/firebase", { body: { idToken } });
      // SplitBot keeps its own session cookie from here on; the Firebase sign-in has done its job.
      const { getAuth, signOut } = await import("firebase/auth");
      await signOut(getAuth(firebaseApp())).catch(() => {});
      track("login", { method: "phone", new_user: res.isNew });
      const { user } = await api<{ user: { id: string; name: string | null } }>("/api/me");
      // Chats saved on this device by another account are wiped before anything can show them.
      await claimChatCache(user.id);
      if (!user.name) setStep("profile");
      else router.replace(next);
    });

  const saveProfile = () =>
    go(async () => {
      await api("/api/me", { method: "PATCH", body: { name, upiId: upi } });
      router.replace(next);
    });

  return (
    <main className="flex flex-1 flex-col bg-head text-white">
      <div className="flex flex-col items-start gap-3 px-6 pb-8 pt-[max(48px,env(safe-area-inset-top))]">
        <BotAvatar size={48} />
        <h1 className="text-3xl font-extrabold tracking-tight">SplitBot</h1>
        <p className="text-[15px] leading-relaxed text-mint">
          Split bills by chatting. Tag <span className="font-bold text-white">@splitbot</span> with what you paid, confirm in one tap,
          settle over UPI.
        </p>
      </div>

      <div className="flex flex-1 flex-col gap-4 rounded-t-3xl bg-white px-6 pb-[max(24px,env(safe-area-inset-bottom))] pt-6 text-ink">
        {!firebaseConfigured && (
          <ErrorNote>
            Login isn&apos;t set up yet. This build is missing {missingFirebaseConfig.join(", ")}. Add them in Vercel → Settings → Environment
            Variables (Production), then redeploy.
          </ErrorNote>
        )}

        {step === "phone" && (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void sendCode();
            }}
          >
            <Field label="Mobile number" hint="We'll send a 6-digit code by SMS.">
              <div className="flex gap-2">
                <span className="flex h-11 items-center rounded-xl border border-edge bg-surface px-3 text-[15px] font-semibold">+91</span>
                <input
                  id="login-phone"
                  className={inputCls}
                  inputMode="tel"
                  autoComplete="tel-national"
                  placeholder="98765 43210"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  autoFocus
                />
              </div>
            </Field>
            <ErrorNote>{error}</ErrorNote>
            <Button
              type="submit"
              loading={busy}
              disabled={!firebaseConfigured || phone.replace(/\D/g, "").length < 10}
              className="h-12 text-base"
            >
              Send code
            </Button>
          </form>
        )}

        {step === "code" && (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void verify();
            }}
          >
            <Field label={`Code sent to ${formatPhone(sentTo)}`}>
              <input
                id="login-code"
                className={inputCls + " text-center font-mono text-xl tracking-[0.4em]"}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                autoFocus
              />
            </Field>
            <ErrorNote>{error}</ErrorNote>
            <Button type="submit" loading={busy} disabled={code.length !== 6} className="h-12 text-base">
              Verify
            </Button>
            <div className="flex justify-between">
              <button type="button" className="text-sm font-bold text-brand" onClick={() => setStep("phone")}>
                Use a different number
              </button>
              <button type="button" className="text-sm font-bold text-brand" disabled={busy} onClick={() => void sendCode()}>
                Resend code
              </button>
            </div>
          </form>
        )}

        {step === "profile" && (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void saveProfile();
            }}
          >
            <h2 className="text-lg font-extrabold">Welcome! What should friends call you?</h2>
            <Field label="Your name">
              <input id="login-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Arjun" autoFocus maxLength={40} />
            </Field>
            <Field label="UPI ID (optional)" hint="Needed so friends can pay you back in one tap. You can add it later.">
              <input id="login-upi" className={inputCls} value={upi} onChange={(e) => setUpi(e.target.value.trim())} placeholder="arjun@okaxis" autoCapitalize="none" />
            </Field>
            <ErrorNote>{error}</ErrorNote>
            <Button type="submit" loading={busy} disabled={!name.trim()} className="h-12 text-base">
              Continue
            </Button>
          </form>
        )}
        {/* Anchor for Firebase's invisible reCAPTCHA. */}
        <div id="recaptcha" />
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}
