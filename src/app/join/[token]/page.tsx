"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Avatar, BotAvatar, Button, ErrorNote, Loading } from "@/components/ui";
import { api, useApi } from "@/lib/client";

interface Invite {
  group: { id: string; name: string; color: string };
  alreadyMember: boolean;
  members: { id: string; name: string; color: string; isPlaceholder: boolean }[];
}

export default function Join() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const { data, error } = useApi<Invite>(`/api/invite/${token}`);
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (data?.alreadyMember) router.replace(`/g/${data.group.id}`);
  }, [data, router]);

  async function join() {
    setBusy(true);
    setErr(null);
    try {
      const { groupId } = await api<{ groupId: string }>(`/api/invite/${token}`, { body: { claimMemberId: pick === "new" ? null : pick } });
      router.replace(`/g/${groupId}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  if (error) return <p className="p-8 text-center text-owe">{error}</p>;
  if (!data || data.alreadyMember) return <Loading />;
  const placeholders = data.members.filter((m) => m.isPlaceholder);

  return (
    <main className="flex flex-1 flex-col bg-head text-white">
      <div className="flex flex-col items-start gap-3 px-6 pb-6 pt-[max(40px,env(safe-area-inset-top))]">
        <BotAvatar size={40} />
        <p className="text-sm text-mint">You&apos;re invited to</p>
        <h1 className="text-3xl font-extrabold tracking-tight">{data.group.name}</h1>
        <p className="text-sm text-mint">{data.members.map((m) => m.name).join(", ")}</p>
      </div>
      <div className="flex flex-1 flex-col gap-3 rounded-t-3xl bg-white px-6 pb-[max(24px,env(safe-area-inset-bottom))] pt-6 text-ink">
        {placeholders.length > 0 && <h2 className="text-base font-extrabold">Which one is you?</h2>}
        {placeholders.length > 0 && (
          <p className="text-[13px] text-muted">Pick your name so expenses already logged for you land on your account.</p>
        )}
        {placeholders.map((m) => (
          <button
            key={m.id}
            onClick={() => setPick(m.id)}
            className={
              "flex items-center gap-3 rounded-xl border-[1.5px] p-3 text-left " + (pick === m.id ? "border-brand bg-tint" : "border-edge")
            }
          >
            <Avatar name={m.name} color={m.color} size={36} />
            <span className="flex-1 font-bold">I&apos;m {m.name}</span>
          </button>
        ))}
        <button
          onClick={() => setPick("new")}
          className={"rounded-xl border-[1.5px] p-3 text-left font-bold " + (pick === "new" ? "border-brand bg-tint" : "border-edge")}
        >
          {placeholders.length ? "I'm not on this list — join as new" : "Join as a new member"}
        </button>
        <ErrorNote>{err}</ErrorNote>
        <Button className="mt-2 h-12 text-base" onClick={join} loading={busy} disabled={!pick}>
          Join group
        </Button>
      </div>
    </main>
  );
}
