"use client";

import { Bell } from "lucide-react";
import { useEffect, useState } from "react";
import { BottomNav, Button, ErrorNote, Field, inputCls, Loading } from "@/components/ui";
import { api, useApi, useBrowserValue } from "@/lib/client";
import { track } from "@/lib/firebase/analytics";
import { disablePush, enablePush, pushState, type PushState } from "@/lib/firebase/push";
import { formatPhone } from "@/lib/phone";

interface Me {
  user: { id: string; phone: string; name: string | null; upiId: string | null };
}

export default function Profile() {
  const { data } = useApi<Me>("/api/me");

  async function logout() {
    await disablePush().catch(() => {}); // stop this device getting this account's notifications
    await api("/api/auth/logout", { body: {} });
    // A full page load, not router.push: it drops this account's cached data from memory, and
    // replace() keeps Back from returning to a logged-out profile.
    window.location.replace("/login");
  }

  return (
    <>
      <div className="shrink-0 bg-head px-4 pb-4 pt-[max(24px,env(safe-area-inset-top))] text-white">
        <h1 className="text-2xl font-extrabold tracking-tight">Profile</h1>
        {data && <p className="text-sm text-mint">{formatPhone(data.user.phone)}</p>}
      </div>
      <div className="no-scrollbar flex flex-1 flex-col gap-4 overflow-y-auto bg-surface p-4">
        {!data ? <Loading /> : <ProfileForm key={data.user.id} user={data.user} />}
        <Notifications />
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

function Notifications() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    pushState().then(setState, () => setState("unsupported"));
  }, []);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      if (state === "on") {
        await disablePush();
      } else {
        const granted = await enablePush();
        track("push_enable", { granted });
        if (!granted) setError("Notifications are blocked. Allow them for SplitBot in your browser settings.");
      }
      setState(await pushState());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!state || state === "unsupported") return null;
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line-2 bg-white p-4">
      <div className="flex items-start gap-3">
        <Bell size={18} className="mt-0.5 shrink-0 text-brand" />
        <div className="flex-1">
          <h2 className="text-sm font-bold">Notifications</h2>
          <p className="text-[13px] leading-relaxed text-muted">
            {state === "needs-install"
              ? "On iPhone, add SplitBot to your Home Screen first (Share → Add to Home Screen), then turn notifications on from there."
              : state === "blocked"
                ? "Notifications are blocked for SplitBot. Allow them in your browser or phone settings."
                : "Get a ping when friends add expenses, confirm a split, or send you a reminder."}
          </p>
        </div>
      </div>
      {(state === "on" || state === "off") && (
        <Button variant={state === "on" ? "ghost" : "primary"} onClick={toggle} loading={busy}>
          {state === "on" ? "Turn off on this device" : "Turn on notifications"}
        </Button>
      )}
      <ErrorNote>{error}</ErrorNote>
    </section>
  );
}
