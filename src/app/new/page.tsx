"use client";

import { useRouter } from "next/navigation";
import { Trash2, UserPlus } from "lucide-react";
import { useState } from "react";
import { Button, ErrorNote, Field, Header, inputCls } from "@/components/ui";
import { api } from "@/lib/client";

export default function NewGroup() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [people, setPeople] = useState<{ name: string; phone: string }[]>([{ name: "", phone: "" }]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const members = people
        .filter((p) => p.name.trim())
        .map((p) => ({ name: p.name.trim(), phone: p.phone.trim() || undefined }));
      const names = members.map((m) => m.name.toLowerCase());
      if (new Set(names).size !== names.length) throw new Error("Two people have the same name. Add a surname or nickname.");
      const { id } = await api<{ id: string }>("/api/groups", { body: { name, members } });
      router.replace(`/g/${id}/info?created=1`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
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
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Toit Friday, Flat 4B, Goa trip…" autoFocus maxLength={50} />
        </Field>

        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-bold">Who&apos;s in it?</span>
          <span className="text-xs text-muted">
            Add friends by name now; they can claim their name from the invite link. A phone number links them automatically when they sign
            up.
          </span>
          {people.map((p, i) => (
            <div key={i} className="flex gap-2">
              <input
                className={inputCls + " flex-[1.2]"}
                placeholder={["Kabir", "Riya", "Neha", "Name"][Math.min(i, 3)]}
                value={p.name}
                onChange={(e) => setPeople(people.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                maxLength={40}
              />
              <input
                className={inputCls + " flex-1"}
                placeholder="Phone (opt.)"
                inputMode="tel"
                value={p.phone}
                onChange={(e) => setPeople(people.map((x, j) => (j === i ? { ...x, phone: e.target.value } : x)))}
              />
              {people.length > 1 && (
                <button type="button" aria-label="Remove" className="px-1 text-muted" onClick={() => setPeople(people.filter((_, j) => j !== i))}>
                  <Trash2 size={18} />
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            className="flex items-center gap-2 self-start py-2 text-sm font-bold text-brand"
            onClick={() => setPeople([...people, { name: "", phone: "" }])}
          >
            <UserPlus size={18} /> Add another
          </button>
        </div>

        <ErrorNote>{error}</ErrorNote>
        <Button type="submit" loading={busy} disabled={!name.trim()} className="h-12 text-base">
          Create group
        </Button>
      </form>
    </>
  );
}
