"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronLeft, MessageSquare, List, User as UserIcon, X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { initials } from "@/lib/colors";
import { formatINR } from "@/lib/money";

export function cx(...xs: (string | false | null | undefined)[]) {
  return xs.filter(Boolean).join(" ");
}

export function Avatar({ name, color, size = 28, label }: { name: string; color: string; size?: number; label?: string }) {
  return (
    <span
      aria-hidden={!label}
      aria-label={label}
      className="flex shrink-0 items-center justify-center rounded-full font-bold text-white"
      style={{ width: size, height: size, background: color, fontSize: Math.round(size * 0.38) }}
    >
      {initials(name)}
    </span>
  );
}

export function BotAvatar({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden className="shrink-0">
      <circle cx="14" cy="14" r="14" fill="#0F7B5F" />
      <path d="M9.5 18.5l9-9" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" />
      <circle cx="10" cy="10" r="2.2" fill="#FFFFFF" />
      <circle cx="18" cy="18" r="2.2" fill="#FFFFFF" />
    </svg>
  );
}

export function Header({
  title,
  subtitle,
  back,
  right,
  avatar,
  onTitleClick,
}: {
  title: string;
  subtitle?: string;
  back?: string | (() => void);
  right?: ReactNode;
  avatar?: ReactNode;
  onTitleClick?: () => void;
}) {
  const router = useRouter();
  return (
    <header className="flex shrink-0 items-center gap-1.5 bg-head px-2 pb-3 pt-[max(14px,env(safe-area-inset-top))] text-white">
      {back && (
        <button
          aria-label="Back"
          onClick={() => (typeof back === "string" ? router.push(back) : back())}
          className="flex h-11 w-11 items-center justify-center rounded-full"
        >
          <ChevronLeft size={24} strokeWidth={2.2} />
        </button>
      )}
      {avatar}
      <button
        type="button"
        onClick={onTitleClick}
        disabled={!onTitleClick}
        className={cx("min-w-0 flex-1 text-left", back ? "pl-1" : "pl-2")}
      >
        <div className="truncate text-base font-bold">{title}</div>
        {subtitle && <div className="truncate text-xs text-mint">{subtitle}</div>}
      </button>
      {right}
    </header>
  );
}

export function BottomNav() {
  const path = usePathname();
  const tabs = [
    { href: "/", label: "Chats", icon: MessageSquare },
    { href: "/activity", label: "Activity", icon: List },
    { href: "/profile", label: "Profile", icon: UserIcon },
  ];
  return (
    <nav className="flex shrink-0 justify-around border-t border-line-2 bg-white pb-[max(14px,env(safe-area-inset-bottom))] pt-1.5">
      {tabs.map((t) => {
        const active = t.href === "/" ? path === "/" : path.startsWith(t.href);
        const Icon = t.icon;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cx(
              "flex min-h-12 min-w-16 flex-col items-center justify-center gap-0.5 text-xs",
              active ? "font-bold text-brand" : "font-semibold text-muted",
            )}
          >
            <Icon size={22} strokeWidth={2} />
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

type BtnVariant = "primary" | "outline" | "ghost" | "danger";
export function Button({
  children,
  variant = "primary",
  className,
  loading,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; loading?: boolean }) {
  const styles: Record<BtnVariant, string> = {
    primary: "bg-brand text-white font-extrabold disabled:bg-[#A9B8B1]",
    outline: "border-[1.5px] border-brand bg-white text-brand font-bold disabled:opacity-50",
    ghost: "border-[1.5px] border-chip bg-white text-ink font-bold disabled:opacity-50",
    danger: "border-[1.5px] border-owe bg-white text-owe font-bold disabled:opacity-50",
  };
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={cx("flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm transition-opacity", styles[variant], className)}
    >
      {loading ? <Spinner light={variant === "primary"} /> : children}
    </button>
  );
}

export function Spinner({ light }: { light?: boolean }) {
  return (
    <span
      className={cx(
        "inline-block h-4 w-4 animate-spin rounded-full border-2",
        light ? "border-white/40 border-t-white" : "border-brand/30 border-t-brand",
      )}
    />
  );
}

export function Pill({ net }: { net: number }) {
  if (net > 0) return <span className="self-start rounded-full bg-owed-bg px-2 py-0.5 text-xs font-bold text-brand-deep">you are owed {formatINR(net)}</span>;
  if (net < 0) return <span className="self-start rounded-full bg-owe-bg px-2 py-0.5 text-xs font-bold text-owe-ink">you owe {formatINR(net)}</span>;
  return <span className="self-start rounded-full bg-line px-2 py-0.5 text-xs font-bold text-muted">settled up</span>;
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" onClick={onClose} role="dialog" aria-modal aria-label={title}>
      <div
        className="sheet-up flex max-h-[88dvh] w-full max-w-md flex-col rounded-t-2xl bg-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-base font-extrabold">{title}</h2>
          <button aria-label="Close" onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-full text-muted">
            <X size={20} />
          </button>
        </div>
        <div className="no-scrollbar overflow-y-auto px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-bold">{label}</span>
      {children}
      {hint && !error && <span className="text-xs text-muted">{hint}</span>}
      {error && <span className="text-xs font-semibold text-owe">{error}</span>}
    </label>
  );
}

export const inputCls =
  "h-11 w-full rounded-xl border border-edge bg-white px-3 text-[15px] outline-none focus:border-brand placeholder:text-faint";

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <div className="rounded-xl bg-owe-bg px-3 py-2 text-[13px] font-semibold text-owe-ink">{children}</div>;
}

export function Loading() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <Spinner />
    </div>
  );
}
