"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { BotAvatar, Button, ErrorNote, Field, inputCls } from "@/components/ui";
import { api } from "@/lib/client";

type Step = "phone" | "code" | "profile";

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/";
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [upi, setUpi] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function go(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const sendCode = () =>
    go(async () => {
      const res = await api<{ phone: string; devCode?: string }>("/api/auth/otp", { body: { phone } });
      setPhone(res.phone);
      setDevCode(res.devCode ?? null);
      if (res.devCode) setCode(res.devCode);
      setStep("code");
    });

  const verify = () =>
    go(async () => {
      await api("/api/auth/verify", { body: { phone, code } });
      const { user } = await api<{ user: { name: string | null } }>("/api/me");
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
        {step === "phone" && (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void sendCode();
            }}
          >
            <Field label="Mobile number" hint="We'll send a 6-digit code.">
              <div className="flex gap-2">
                <span className="flex h-11 items-center rounded-xl border border-edge bg-surface px-3 text-[15px] font-semibold">+91</span>
                <input
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
            <Button type="submit" loading={busy} disabled={phone.replace(/\D/g, "").length < 10} className="h-12 text-base">
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
            <Field label={`Code sent to ${phone}`}>
              <input
                className={inputCls + " text-center font-mono text-xl tracking-[0.4em]"}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                autoFocus
              />
            </Field>
            {devCode && (
              <div className="rounded-xl bg-tint px-3 py-2 text-[13px] text-brand-deep">
                SMS isn&apos;t set up yet, so your code is <b className="font-mono">{devCode}</b> (filled in for you).
              </div>
            )}
            <ErrorNote>{error}</ErrorNote>
            <Button type="submit" loading={busy} disabled={code.length !== 6} className="h-12 text-base">
              Verify
            </Button>
            <button type="button" className="text-sm font-bold text-brand" onClick={() => setStep("phone")}>
              Use a different number
            </button>
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
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Arjun" autoFocus maxLength={40} />
            </Field>
            <Field label="UPI ID (optional)" hint="Needed so friends can pay you back in one tap. You can add it later.">
              <input className={inputCls} value={upi} onChange={(e) => setUpi(e.target.value.trim())} placeholder="arjun@okaxis" autoCapitalize="none" />
            </Field>
            <ErrorNote>{error}</ErrorNote>
            <Button type="submit" loading={busy} disabled={!name.trim()} className="h-12 text-base">
              Continue
            </Button>
          </form>
        )}
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
