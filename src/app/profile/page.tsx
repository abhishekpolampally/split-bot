"use client";

import { useState } from "react";
import { BottomNav, Button, ErrorNote, Field, inputCls, Loading } from "@/components/ui";
import { api, useApi, useBrowserValue } from "@/lib/client";

interface Me {
  user: { id: string; phone: string; name: string | null; upiId: string | null };
}

export default function Profile() {
  const { data } = useApi<Me>("/api/me");

  async function logout() {
    await api("/api/auth/logout", { body: {} });
    window.location.assign("/login");
  }

  return (
    <>
      <div className="shrink-0 bg-head px-4 pb-4 pt-[max(24px,env(safe-area-inset-top))] text-white">
        <h1 className="text-2xl font-extrabold tracking-tight">Profile</h1>
        {data && <p className="text-sm text-mint">{data.user.phone}</p>}
      </div>
      <div className="no-scrollbar flex flex-1 flex-col gap-4 overflow-y-auto bg-surface p-4">
        {!data ? <Loading /> : <ProfileForm key={data.user.id} user={data.user} />}
        <InstallHint />
        <Button variant="ghost" onClick={logout}>
          Log out
        </Button>
      </div>
      <BottomNav />
    </>
  );
}

function ProfileForm({ user }: { user: Me["user"] }) {
  const [name, setName] = useState(user.name ?? "");
  const [upi, setUpi] = useState(user.upiId ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await api("/api/me", { method: "PATCH", body: { name, upiId: upi } });
      setMsg("Saved.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-4 rounded-2xl border border-line-2 bg-white p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Field label="Name">
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
      </Field>
      <Field label="UPI ID" hint="Friends' UPI apps open with your ID, the amount and a note filled in.">
        <input className={inputCls} value={upi} onChange={(e) => setUpi(e.target.value.trim())} placeholder="name@okhdfcbank" autoCapitalize="none" />
      </Field>
      <ErrorNote>{error}</ErrorNote>
      {msg && <p className="text-sm font-semibold text-brand">{msg}</p>}
      <Button type="submit" loading={busy}>
        Save
      </Button>
    </form>
  );
}

function InstallHint() {
  const standalone = useBrowserValue(() => window.matchMedia("(display-mode: standalone)").matches, true);
  if (standalone) return null;
  return (
    <div className="rounded-2xl border border-card-edge bg-tint p-4 text-[13px] leading-relaxed text-brand-deep">
      <b>Install SplitBot:</b> on iPhone tap Share → <i>Add to Home Screen</i>. On Android tap ⋮ → <i>Install app</i>.
    </div>
  );
}
