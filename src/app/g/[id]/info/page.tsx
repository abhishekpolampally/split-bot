"use client";

import { useParams, useSearchParams } from "next/navigation";
import { Copy, Share2, UserPlus } from "lucide-react";
import { Suspense, useState } from "react";
import { Avatar, Button, ErrorNote, Field, Header, inputCls, Loading } from "@/components/ui";
import { api, useApi, useBrowserValue } from "@/lib/client";
import type { MemberView } from "@/lib/types";

interface GroupInfo {
  group: { id: string; name: string; color: string; inviteToken: string };
  meId: string;
  members: MemberView[];
}

function Info() {
  const { id } = useParams<{ id: string }>();
  const created = useSearchParams().get("created");
  const { data, reload } = useApi<GroupInfo>(`/api/groups/${id}`);
  const [copied, setCopied] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const origin = useBrowserValue(() => location.origin, "");

  if (!data) return <Loading />;
  const link = `${origin}/join/${data.group.inviteToken}`;
  const shareText = `Join “${data.group.name}” on SplitBot so we can split bills in the chat: ${link}`;

  async function share() {
    if (navigator.share) {
      try {
        await navigator.share({ title: "SplitBot", text: shareText });
        return;
      } catch {
        /* cancelled */
      }
    }
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function add() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/groups/${id}/members`, { body: { name, phone: phone || undefined } });
      setName("");
      setPhone("");
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }


  return (
    <>
      <Header title="Group info" subtitle={data.group.name} back={`/g/${id}`} />
      <div className="no-scrollbar flex flex-1 flex-col gap-4 overflow-y-auto bg-surface p-4">
        {created && (
          <div className="rounded-2xl border border-card-edge bg-tint p-4 text-sm leading-relaxed text-brand-deep">
            <b>Group created.</b> Share the invite link so friends can join and claim their names. You can start logging expenses straight away;
            they&apos;ll see everything once they join.
          </div>
        )}

        <section className="flex flex-col gap-3 rounded-2xl border border-line-2 bg-white p-4">
          <h2 className="text-sm font-bold">Invite link</h2>
          <div className="truncate rounded-xl bg-surface px-3 py-2.5 font-mono text-xs">{link}</div>
          <div className="flex gap-2">
            <Button className="flex-1" onClick={share}>
              <Share2 size={16} /> Share invite
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              onClick={async () => {
                await navigator.clipboard.writeText(link);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              <Copy size={16} /> {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <a
            href={`https://wa.me/?text=${encodeURIComponent(shareText)}`}
            target="_blank"
            rel="noreferrer"
            className="text-center text-sm font-bold text-brand"
          >
            Send on WhatsApp
          </a>
        </section>

        <section className="flex flex-col gap-1 rounded-2xl border border-line-2 bg-white px-4 py-2">
          <h2 className="py-2 text-sm font-bold">{data.members.length} members</h2>
          {data.members.map((m) => (
            <div key={m.id} className="flex items-center gap-3 border-b border-line py-2 last:border-0">
              <Avatar name={m.name} color={m.color} size={36} />
              <div className="flex-1">
                <div className="text-[15px] font-bold">{m.id === data.meId ? `${m.name} (you)` : m.name}</div>
                <div className="text-xs text-muted">
                  {m.isPlaceholder ? "Hasn't joined yet" : m.upiId ? `UPI: ${m.upiId}` : "No UPI ID yet"}
                </div>
              </div>
            </div>
          ))}
        </section>

        <form
          className="flex flex-col gap-3 rounded-2xl border border-line-2 bg-white p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <h2 className="flex items-center gap-2 text-sm font-bold">
            <UserPlus size={16} /> Add someone
          </h2>
          <div className="flex gap-2">
            <input className={inputCls + " flex-[1.2]"} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
            <input className={inputCls + " flex-1"} placeholder="Phone (opt.)" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <ErrorNote>{error}</ErrorNote>
          <Button type="submit" variant="outline" loading={busy} disabled={!name.trim()}>
            Add to group
          </Button>
        </form>

        <RenameGroup key={data.group.name} id={id} current={data.group.name} onDone={reload} />
      </div>
    </>
  );
}

function RenameGroup({ id, current, onDone }: { id: string; current: string; onDone: () => void }) {
  const [groupName, setGroupName] = useState(current);
  async function rename() {
    if (!groupName.trim() || groupName === current) return;
    await api(`/api/groups/${id}`, { method: "PATCH", body: { name: groupName } });
    onDone();
  }
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line-2 bg-white p-4">
      <Field label="Group name">
        <input className={inputCls} value={groupName} onChange={(e) => setGroupName(e.target.value)} onBlur={rename} maxLength={50} />
      </Field>
    </section>
  );
}

export default function InfoPage() {
  return (
    <Suspense>
      <Info />
    </Suspense>
  );
}
