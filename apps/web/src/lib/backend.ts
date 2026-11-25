import type { EnterpriseState, EntRequest, EntResponse, SessionInfo } from "@archymedes/engine/api-types";
import { EnterpriseHost } from "@archymedes/engine/host";
import type { Persisted } from "@archymedes/engine/host";
import type { WorkspaceInput, WorkspaceSlices } from "@archymedes/engine/templates";

/**
 * Where the workspace lives. "browser": the full engine runs in the page and
 * the workspace is saved in this browser — no account, nothing leaves the
 * device. "cloud": the same API on Cloudflare, shared by the team (enabled
 * with NEXT_PUBLIC_HOSTED=1 once sign-in is switched on).
 */
export interface Backend {
  readonly kind: "browser" | "cloud";
  session(): Promise<SessionInfo>;
  selectIdentity(memberId: string): Promise<void>;
  createWorkspace(input: WorkspaceInput): Promise<void>;
  request(req: EntRequest): Promise<EntResponse>;
  reset(): Promise<void>;
  /** Server-side sync of a connected source (cloud only). */
  syncSource?(workspaceId: string, sourceId: string): Promise<{ imported: number; duplicates: number }>;
  setSourceSecret?(workspaceId: string, sourceId: string, secret: string): Promise<void>;
  invite?(workspaceId: string, memberId: string): Promise<{ url: string }>;
  exportTenant(): Promise<{ slices: WorkspaceSlices; adminMemberId: string } | null>;
}

export const HOSTED = process.env.NEXT_PUBLIC_HOSTED === "1";
export const STATE_KEY = "archymedes.os.state.v1";

type KeyValue = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The slices of one tenant, for moving a browser workspace into the cloud. */
export function tenantSlices(st: EnterpriseState, tenantId: string): WorkspaceSlices {
  const of = <T extends { tenantId: string }>(xs: T[] | undefined) => (xs ?? []).filter((x) => x.tenantId === tenantId);
  const latest = <T extends { tenantId: string; version: number }>(xs: T[]) => of(xs).sort((a, b) => b.version - a.version)[0];
  return {
    tenant: st.tenants.find((t) => t.id === tenantId)!,
    members: of(st.members),
    profile: latest(st.profiles),
    policy: latest(st.policies),
    metrics: of(st.metrics),
    objectives: of(st.objectives),
    rows: of(st.rows),
    imports: of(st.imports),
    decisions: of(st.decisions),
    evaluations: of(st.evaluations),
    approvals: of(st.approvals),
    work: of(st.work),
    evidence: of(st.evidence),
    outcomes: of(st.outcomes),
    moats: of(st.moats),
    forecasts: of(st.forecasts),
    outbox: of(st.outbox),
    tasks: of(st.tasks),
    audit: of(st.audit).map(({ seq: _seq, ...rest }) => rest),
  };
}

export function browserBackend(storage: KeyValue, now?: () => string): Backend {
  let last: Persisted | null = null;
  const host = new EnterpriseHost(
    {
      async load() {
        const raw = storage.getItem(STATE_KEY);
        last = raw ? (JSON.parse(raw) as Persisted) : null;
        return last;
      },
      async save(data) {
        last = data;
        try {
          storage.setItem(STATE_KEY, JSON.stringify(data));
        } catch {
          // Storage full or blocked: the session keeps working; it just won't survive a reload.
        }
      },
    },
    { now },
  );
  return {
    kind: "browser",
    session: () => host.session(),
    selectIdentity: (id) => host.signIn(id),
    createWorkspace: (input) => host.createWorkspace(structuredClone(input)),
    request: (req) => host.request(structuredClone(req)),
    reset: () => host.resetAll(),
    async exportTenant() {
      const s = await host.session();
      const me = s.identities.find((i) => i.id === s.actorId);
      if (!me || !last) return null;
      const tenant = last.state.tenants.find((t) => t.workspaceId === me.workspaceId)!;
      return { slices: tenantSlices(last.state, tenant.id), adminMemberId: me.id };
    },
  };
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Archymedes": "1", ...(init.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message: string } };
  if (!res.ok) throw new Error(body.error?.message ?? `Request failed (${res.status})`);
  return body;
}

export function cloudBackend(): Backend {
  return {
    kind: "cloud",
    session: () => api<SessionInfo>("/api/session"),
    selectIdentity: async (memberId) => void (await api("/api/session", { method: "POST", body: JSON.stringify({ memberId }) })),
    createWorkspace: async (input) => void (await api("/api/workspaces", { method: "POST", body: JSON.stringify({ input }) })),
    async request(req) {
      const res = await fetch(`/api${req.path}`, {
        method: req.method,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Archymedes": "1", ...(req.idempotencyKey ? { "Idempotency-Key": req.idempotencyKey } : {}), ...(req.ifRevision !== undefined ? { "If-Match": String(req.ifRevision) } : {}) },
        ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    reset: async () => {
      window.location.href = "/auth/logout";
    },
    syncSource: (ws, id) => api(`/api/sources/${ws}/${id}/sync`, { method: "POST", body: "{}" }),
    setSourceSecret: async (ws, id, secret) => void (await api(`/api/sources/${ws}/${id}/secret`, { method: "PUT", body: JSON.stringify({ secret }) })),
    invite: (ws, memberId) => api<{ url: string }>("/api/invites", { method: "POST", body: JSON.stringify({ workspaceId: ws, memberId }) }),
    exportTenant: async () => null,
  };
}
