"use client";

import { BookUser, Search } from "lucide-react";
import { useState } from "react";
import { Button, ErrorNote, Field, inputCls } from "@/components/ui";
import { api, useBrowserValue } from "@/lib/client";
import { track } from "@/lib/firebase/analytics";
import { formatPhone, normalisePhone } from "@/lib/phone";

export interface Person {
  name?: string;
  phone: string;
}

interface ContactsManager {
  select(props: ("name" | "tel")[], opts: { multiple: boolean }): Promise<{ name?: string[]; tel?: string[] }[]>;
}

interface Lookup {
  phone: string;
  onSplitBot: boolean;
  name: string | null;
  isYou?: boolean;
}

/**
 * The only two ways an owner adds people: pick them from the phone's contacts (Chrome on
 * Android), or type a full mobile number, which is checked against SplitBot's users. Everyone
 * else joins through the invite link.
 */
export function AddPeople({ onAdd, label = "Add people" }: { onAdd: (p: Person) => Promise<void>; label?: string }) {
  // The Contact Picker API exists in Chrome on Android only.
  const hasContacts = useBrowserValue(() => typeof (navigator as { contacts?: Partial<ContactsManager> }).contacts?.select === "function", false);
  const [number, setNumber] = useState("");
  const [found, setFound] = useState<Lookup | null>(null);
  const [newName, setNewName] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"contacts" | "lookup" | "add" | null>(null);

  async function fromContacts() {
    setBusy("contacts");
    setError(null);
    setNote(null);
    try {
      const picked = await (navigator as unknown as { contacts: ContactsManager }).contacts.select(["name", "tel"], { multiple: true });
      const failures: string[] = [];
      let added = 0;
      let skipped = 0;
      for (const c of picked) {
        const phone = (c.tel ?? []).map((t) => normalisePhone(t)).find(Boolean);
        const name = c.name?.[0]?.trim();
        if (!phone) {
          skipped++;
          continue;
        }
        try {
          await onAdd({ name, phone });
          track("member_add", { via: "contacts", on_splitbot: false });
          added++;
        } catch (e) {
          failures.push((e as Error).message);
        }
      }
      if (skipped) failures.push(`Skipped ${skipped} contact${skipped === 1 ? "" : "s"} without a mobile number.`);
      if (added) setNote(`Added ${added} ${added === 1 ? "person" : "people"}.`);
      if (failures.length) setError(failures.join(" "));
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError("Couldn't open your contacts.");
    } finally {
      setBusy(null);
    }
  }

  async function lookup() {
    setBusy("lookup");
    setError(null);
    setNote(null);
    setFound(null);
    try {
      const res = await api<Lookup>(`/api/users/lookup?phone=${encodeURIComponent(number)}`);
      setFound(res);
      setNewName("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function addFound() {
    if (!found) return;
    setBusy("add");
    setError(null);
    try {
      await onAdd({ phone: found.phone, name: found.onSplitBot ? (found.name ?? undefined) : newName.trim() });
      track("member_add", { via: "number", on_splitbot: found.onSplitBot });
      setNote(`Added ${found.onSplitBot ? found.name : newName.trim()}.`);
      setFound(null);
      setNumber("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const validNumber = Boolean(normalisePhone(number));

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-bold">{label}</h2>
      {hasContacts && (
        <Button type="button" variant="outline" onClick={fromContacts} loading={busy === "contacts"}>
          <BookUser size={16} /> Choose from contacts
        </Button>
      )}

      <Field label={hasContacts ? "Or add by mobile number" : "Add by mobile number"}>
        <div className="flex gap-2">
          <input
            id="add-number"
            className={inputCls}
            inputMode="tel"
            placeholder="98765 43210"
            value={number}
            onChange={(e) => {
              setNumber(e.target.value);
              setFound(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (validNumber) void lookup();
              }
            }}
          />
          <Button type="button" variant="outline" onClick={lookup} loading={busy === "lookup"} disabled={!validNumber} aria-label="Look up number">
            <Search size={16} />
          </Button>
        </div>
      </Field>

      {found?.isYou && <p className="text-[13px] text-muted">That&apos;s your own number.</p>}
      {found && !found.isYou && found.onSplitBot && (
        <div className="flex items-center gap-3 rounded-xl border border-card-edge bg-tint p-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-bold">{found.name ?? formatPhone(found.phone)}</div>
            <div className="text-xs text-brand-deep">On SplitBot · {formatPhone(found.phone)}</div>
          </div>
          <Button type="button" onClick={addFound} loading={busy === "add"}>
            Add
          </Button>
        </div>
      )}
      {found && !found.isYou && !found.onSplitBot && (
        <div className="flex flex-col gap-2 rounded-xl border border-edge p-3">
          <p className="text-[13px] text-muted">
            {formatPhone(found.phone)} isn&apos;t on SplitBot yet. Add them by name; they&apos;ll be linked when they sign up with this number.
          </p>
          <div className="flex gap-2">
            <input id="add-name" className={inputCls} placeholder="Their name" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={40} />
            <Button type="button" onClick={addFound} loading={busy === "add"} disabled={!newName.trim()}>
              Add
            </Button>
          </div>
        </div>
      )}
      {note && <p className="text-[13px] font-semibold text-brand">{note}</p>}
      <ErrorNote>{error}</ErrorNote>
    </div>
  );
}
