"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? (init?.body ? "POST" : "GET"),
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && typeof window !== "undefined" && !location.pathname.startsWith("/login")) {
    // Session gone: a full page load clears the stale data, and replace() keeps the dead page out of history.
    window.location.replace(`/login?next=${encodeURIComponent(location.pathname)}`);
  }
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? "Something went wrong.");
  return data as T;
}

/** Fetch JSON, optionally re-fetching on an interval while the tab is visible. */
export function useApi<T>(path: string | null, intervalMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [path]);

  useEffect(() => {
    // Fetch-on-mount: state is only set after the request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
    if (!intervalMs) return;
    const t = setInterval(() => document.visibilityState === "visible" && void reload(), intervalMs);
    const onVis = () => document.visibilityState === "visible" && void reload();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [intervalMs, reload]);

  return { data, error, reload, setData };
}

export function timeLabel(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  const diff = (now.getTime() - d.getTime()) / 86400000;
  if (diff < 6) return d.toLocaleDateString("en-IN", { weekday: "short" });
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export function clockLabel(iso: string) {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
}

export function dayLabel(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "Today";
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  const diff = (now.getTime() - d.getTime()) / 86400000;
  if (diff < 6) return d.toLocaleDateString("en-IN", { weekday: "long" });
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

const noopSubscribe = () => () => {};

/** Browser-only values without a hydration mismatch (server snapshot = fallback). */
export function useBrowserValue<T>(get: () => T, fallback: T): T {
  return useSyncExternalStore(noopSubscribe, get, () => fallback);
}
