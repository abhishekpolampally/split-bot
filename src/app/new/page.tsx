"use client";

import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { useState } from "react";
import { AddPeople, type Person } from "@/components/AddPeople";
import { Avatar, Button, ErrorNote, Field, Header, inputCls } from "@/components/ui";
import { api } from "@/lib/client";
import { track } from "@/lib/firebase/analytics";
import { PALETTE } from "@/lib/colors";
import { formatPhone, normalisePhone } from "@/lib/phone";

export default function NewGroup() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [people, setPeople] = useState<(Person & { name: string })[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const { id } = await api<{ id: string }>("/api/groups", { body: { name, members: people } });
      track("group_create", { members: people.length + 1 });
      router.replace(`/g/${id}/info?created=1`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  /** People are only collected here; the server re-checks everything when the group is created. */
  async function collect(p: Person) {
    const phone = normalisePhone(p.phone)!;
    const display = p.name?.trim();
    if (!display) throw new Error("Add a name for this person.");
    if (people.some((x) => normalisePhone(x.phone) === phone)) throw new Error(`${display} is already on the list.`);
    if (people.some((x) => x.name.toLowerCase() === display.toLowerCase())) {
      throw new Error(`There's already a ${display} on the list. Use a surname or nickname.`);
    }
    setPeople((cur) => [...cur, { name: display, phone }]);
  }

  return (
    <>
      <Header title="New group" back="/" />
      <form
        className="no-scrollbar flex flex-1 flex-col gap-5 overflow-y-auto bg-surface p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <Field label="Group name">
          <input id="group-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Toit Friday, Flat 4B, Goa trip…" autoFocus maxLength={50} />
        </Field>

        <section className="flex flex-col gap-3 rounded-2xl border border-line-2 bg-white p-4">
          <AddPeople label="Who's in it?" onAdd={collect} />
          <p className="text-xs text-muted">You can also add people later, or share the invite link once the group exists.</p>
          {people.map((p, i) => (
            <div key={p.phone} className="flex items-center gap-3 border-t border-line pt-2">
              <Avatar name={p.name} color={PALETTE[(i + 1) % PALETTE.length]} size={32} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-bold">{p.name}</div>
                <div className="text-xs text-muted">{formatPhone(p.phone)}</div>
              </div>
              <button type="button" aria-label={`Remove ${p.name}`} className="p-1 text-muted" onClick={() => setPeople(people.filter((x) => x.phone !== p.phone))}>
                <X size={18} />
              </button>
            </div>
          ))}
        </section>

        <ErrorNote>{error}</ErrorNote>
        <Button type="submit" loading={busy} disabled={!name.trim()} className="h-12 text-base">
          Create group
        </Button>
      </form>
    </>
  );
}
