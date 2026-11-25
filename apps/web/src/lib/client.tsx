"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { EntMethod, Member, SessionInfo } from "@archymedes/engine/api-types";
import { formatMoney, formatPct } from "@archymedes/engine/money";
import type { Backend } from "./backend";

export class EntCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type Identity = SessionInfo["identities"][number];

interface Ctx {
  backend: Backend;
  me: Identity;
  workspaceId: string;
  currency: string;
  setCurrency(c: string): void;
  version: number;
  call<T>(method: EntMethod, path: string, body?: unknown, opts?: { ifRevision?: number; idempotent?: boolean }): Promise<T>;
}

const EntContext = createContext<Ctx | null>(null);

export function useEnt(): Ctx {
  const c = useContext(EntContext);
  if (!c) throw new Error("useEnt outside EntProvider");
  return c;
}

const newKey = () => globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function EntProvider({ backend, me, children }: { backend: Backend; me: Identity; children: ReactNode }) {
  const [version, setVersion] = useState(0);
  const [currency, setCurrency] = useState("USD");
  const call = useCallback(
    async <T,>(method: EntMethod, path: string, body?: unknown, opts: { ifRevision?: number; idempotent?: boolean } = {}): Promise<T> => {
      const res = await backend.request({
        method,
        path: `/v1/workspaces/${me.workspaceId}${path}`,
        ...(body === undefined ? {} : { body }),
        ...(opts.ifRevision === undefined ? {} : { ifRevision: opts.ifRevision }),
        ...(method !== "GET" && opts.idempotent !== false ? { idempotencyKey: newKey() } : {}),
      });
      if (res.status >= 400) {
        const e = (res.body as { error?: { code: string; message: string } }).error;
        throw new EntCallError(res.status, e?.code ?? "error", e?.message ?? `Request failed (${res.status})`);
      }
      if (method !== "GET") setVersion((v) => v + 1);
      return res.body as T;
    },
    [backend, me.workspaceId],
  );
  return <EntContext.Provider value={{ backend, me, workspaceId: me.workspaceId, currency, setCurrency, version, call }}>{children}</EntContext.Provider>;
}

/** GET a resource; refetches after every mutation and when the path changes. */
export function useGet<T>(path: string | null): { data: T | null; error: EntCallError | null; reload(): void } {
  const { call, version } = useEnt();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<EntCallError | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    call<T>("GET", path)
      .then((d) => {
        if (live) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => live && setError(e instanceof EntCallError ? e : new EntCallError(0, "error", String(e))));
    return () => {
      live = false;
    };
  }, [call, path, version, nonce]);
  return { data, error, reload: () => setNonce((n) => n + 1) };
}

/** Runs a mutation with busy and error state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

// ---- formatting ----
export const money = (minor: number | null | undefined, currency: string, opts?: { compact?: boolean; signed?: boolean }) => (minor === null || minor === undefined ? "—" : formatMoney(minor, currency, opts));
export const pct = (p: number | null | undefined, digits = 0) => formatPct(p ?? null, digits);
export const date = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
export const dateShort = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
export function ago(iso: string, now = Date.now()): string {
  const h = (now - Date.parse(iso)) / 3_600_000;
  if (h < 1) return "just now";
  if (h < 48) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
export function metricValue(v: number | null | undefined, unit: "money" | "count" | "ratio", currency: string, compact = false): string {
  if (v === null || v === undefined) return "—";
  if (unit === "money") return formatMoney(Math.round(v), currency, { compact });
  if (unit === "ratio") return formatPct(v, 1);
  return Math.round(v).toLocaleString("en-US");
}
export const ROLE: Record<Member["role"], string> = { admin: "Admin", executive: "Executive", lead: "Lead", operator: "Operator", finance: "Finance", auditor: "Auditor" };
export const STATE_LABEL: Record<string, string> = { Draft: "Draft", Evaluated: "Compared", NeedsEvidence: "Needs evidence", AwaitingApproval: "Awaiting approval", Approved: "Approved", Rejected: "Rejected", Executing: "In progress", DeliveryReview: "Delivery review", Measuring: "Measuring", Debriefed: "Learned", Cancelled: "Cancelled" };
export type Tone = "neutral" | "good" | "warn" | "bad" | "accent";
export function stateTone(s: string): Tone {
  if (["AwaitingApproval", "DeliveryReview", "NeedsEvidence"].includes(s)) return "warn";
  if (["Rejected", "Cancelled"].includes(s)) return "bad";
  if (["Debriefed", "Approved"].includes(s)) return "good";
  if (["Executing", "Measuring"].includes(s)) return "accent";
  return "neutral";
}
