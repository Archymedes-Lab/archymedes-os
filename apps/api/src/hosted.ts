import type { EntRequest, EntResponse } from "@archymedes/engine/api-types";
import { buildWorkspace, validateWorkspaceInput } from "@archymedes/engine/templates";
import type { WorkspaceInput, WorkspaceSlices } from "@archymedes/engine/templates";
import type { User } from "./auth";
import { randomToken } from "./auth";
import type { Membership } from "./directory";
import type { Identity } from "./tenant";

/** What the hosted service needs from the directory and each tenant (Durable Object stubs in production). */
export interface DirectoryLike {
  memberships(sub: string): Promise<Membership[]>;
  addMembership(sub: string, m: Membership): Promise<void>;
  memberIn(sub: string, workspaceId: string): Promise<string | null>;
  lastUsed(sub: string): Promise<string | null>;
  setLastUsed(sub: string, memberId: string): Promise<void>;
  createInvite(workspaceId: string, memberId: string, createdBy: string): Promise<string>;
  redeem(code: string, sub: string): Promise<Membership>;
}

export interface TenantLike {
  init(w: WorkspaceSlices): Promise<void>;
  setSecret(sourceId: string, sealed: string): Promise<void>;
  getSecret(sourceId: string): Promise<string | null>;
  identity(memberId: string): Promise<Identity | null>;
  handle(memberId: string, req: EntRequest): Promise<EntResponse>;
}

export class HostedError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const notFound = (): EntResponse => ({ status: 404, body: { error: { code: "not_found", message: "No such resource in this workspace." } } });

/**
 * The hosted Enterprise API: a person signs in once (AuthKit), may belong to
 * several company workspaces, and every request runs as their member in that
 * workspace. Workspaces never see each other.
 */
export class Hosted {
  constructor(
    private readonly deps: {
      directory: DirectoryLike;
      tenant(workspaceId: string): TenantLike;
      now: () => string;
      /** Key material for sealing connector credentials (AES-GCM). */
      secretKey?: string;
      /** Document bytes, keyed by workspace and document id (R2 in production). */
      files?: { put(key: string, bytes: Uint8Array): Promise<void>; get(key: string): Promise<Uint8Array | null> };
      fetch?: (url: string, init?: RequestInit) => Promise<Response>;
    },
  ) {}

  private newId = (prefix: string) => `${prefix}-${randomToken(9)}`;

  async session(user: User): Promise<{ actorId: string | null; identities: Identity[] }> {
    const ms = await this.deps.directory.memberships(user.sub);
    const identities = (await Promise.all(ms.map((m) => this.deps.tenant(m.workspaceId).identity(m.memberId)))).filter((x): x is Identity => !!x);
    const last = await this.deps.directory.lastUsed(user.sub);
    return { actorId: identities.find((i) => i.id === last)?.id ?? identities[0]?.id ?? null, identities };
  }

  async selectIdentity(user: User, memberId: string): Promise<void> {
    const ms = await this.deps.directory.memberships(user.sub);
    if (!ms.some((m) => m.memberId === memberId)) throw new HostedError(404, "Unknown identity.");
    await this.deps.directory.setLastUsed(user.sub, memberId);
  }

  async createWorkspace(user: User, input: WorkspaceInput): Promise<{ workspaceId: string }> {
    const bad = validateWorkspaceInput(input);
    if (bad.length) throw new HostedError(400, `Check these fields: ${bad.join(", ")}`);
    const w = buildWorkspace(input, this.deps.now(), this.newId);
    return this.install(user, w, w.members[0].id);
  }

  /** Moves a browser trial workspace into the cloud under fresh tenant and workspace ids. */
  async importWorkspace(user: User, slices: WorkspaceSlices, adminMemberId: string): Promise<{ workspaceId: string }> {
    if (!slices?.tenant?.id || !slices.tenant.workspaceId || !Array.isArray(slices.members)) throw new HostedError(400, "Not a workspace export.");
    const admin = slices.members.find((m) => m.id === adminMemberId);
    if (!admin || admin.role !== "admin") throw new HostedError(400, "The uploader must be an admin in the workspace.");
    if (JSON.stringify(slices).length > 20_000_000) throw new HostedError(413, "Workspace export is too large to import.");
    const tenantId = this.newId("t");
    const workspaceId = `ws-${randomToken(9).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
    const text = JSON.stringify(slices).split(JSON.stringify(slices.tenant.id).slice(1, -1)).join(tenantId).split(JSON.stringify(slices.tenant.workspaceId).slice(1, -1)).join(workspaceId);
    const w = JSON.parse(text) as WorkspaceSlices;
    for (const k of ["rows", "imports", "decisions", "evaluations", "approvals", "work", "evidence", "outcomes", "moats", "forecasts", "outbox", "tasks", "audit", "metrics", "objectives"] as const) (w as unknown as Record<string, unknown[]>)[k] ??= [];
    return this.install(user, w, adminMemberId);
  }

  private async install(user: User, w: WorkspaceSlices, adminMemberId: string): Promise<{ workspaceId: string }> {
    await this.deps.tenant(w.tenant.workspaceId).init(w);
    await this.deps.directory.addMembership(user.sub, { workspaceId: w.tenant.workspaceId, memberId: adminMemberId });
    await this.deps.directory.setLastUsed(user.sub, adminMemberId);
    return { workspaceId: w.tenant.workspaceId };
  }

  async request(user: User, req: EntRequest): Promise<EntResponse> {
    const m = /^\/v1\/workspaces\/([\w-]+)\//.exec(req.path);
    if (!m) return notFound();
    const memberId = await this.deps.directory.memberIn(user.sub, m[1]);
    if (!memberId) return notFound();
    return this.deps.tenant(m[1]).handle(memberId, req);
  }

  async invite(user: User, workspaceId: string, memberId: string): Promise<{ code: string }> {
    const me = await this.deps.directory.memberIn(user.sub, workspaceId);
    const myIdentity = me && (await this.deps.tenant(workspaceId).identity(me));
    if (!myIdentity) throw new HostedError(404, "No such workspace.");
    if (myIdentity.role !== "admin") throw new HostedError(403, "Only an admin can invite people.");
    if (!(await this.deps.tenant(workspaceId).identity(memberId))) throw new HostedError(404, "No such member.");
    return { code: await this.deps.directory.createInvite(workspaceId, memberId, user.sub) };
  }

  // ---- connectors ----

  private async memberOr404(user: User, workspaceId: string): Promise<{ memberId: string; identity: Identity }> {
    const memberId = await this.deps.directory.memberIn(user.sub, workspaceId);
    const identity = memberId && (await this.deps.tenant(workspaceId).identity(memberId));
    if (!memberId || !identity) throw new HostedError(404, "No such workspace.");
    return { memberId, identity };
  }

  private async adminOnly(user: User, workspaceId: string): Promise<string> {
    const { memberId, identity } = await this.memberOr404(user, workspaceId);
    if (identity.role !== "admin") throw new HostedError(403, "Only an admin can manage data sources.");
    return memberId;
  }

  private async call<T>(workspaceId: string, memberId: string, req: EntRequest): Promise<T> {
    const r = await this.deps.tenant(workspaceId).handle(memberId, req);
    if (r.status >= 400) throw new HostedError(r.status, (r.body as { error?: { message?: string } }).error?.message ?? "Request failed.");
    return r.body as T;
  }

  private async aesKey(): Promise<CryptoKey> {
    if (!this.deps.secretKey || this.deps.secretKey.length < 32) throw new HostedError(500, "Connector encryption is not configured.");
    const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(this.deps.secretKey));
    return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  }

  private async seal(plain: string, aad: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, await this.aesKey(), new TextEncoder().encode(plain));
    return `${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...new Uint8Array(ct)))}`;
  }

  private async open(sealed: string, aad: string): Promise<string> {
    const [iv, ct] = sealed.split(".").map((x) => Uint8Array.from(atob(x), (c) => c.charCodeAt(0)));
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, await this.aesKey(), ct);
    return new TextDecoder().decode(pt);
  }

  async setSourceSecret(user: User, workspaceId: string, sourceId: string, secret: string): Promise<void> {
    const memberId = await this.adminOnly(user, workspaceId);
    if (!secret.trim() || secret.length > 500) throw new HostedError(400, "Paste the key exactly as given.");
    const { sources } = await this.call<{ sources: { id: string; kind: string }[] }>(workspaceId, memberId, { method: "GET", path: `/v1/workspaces/${workspaceId}/sources` });
    if (!sources.some((x) => x.id === sourceId)) throw new HostedError(404, "No such source.");
    await this.deps.tenant(workspaceId).setSecret(sourceId, await this.seal(secret.trim(), `${workspaceId}/${sourceId}`));
    await this.call(workspaceId, memberId, { method: "POST", path: `/v1/workspaces/${workspaceId}/sources/${sourceId}`, body: { hasSecret: true } });
  }

  /** Pulls a source on the server and lands it through the workspace's import checks. */
  async syncSource(user: User, workspaceId: string, sourceId: string): Promise<{ imported: number; duplicates: number }> {
    const memberId = await this.adminOnly(user, workspaceId);
    const base = `/v1/workspaces/${workspaceId}`;
    const { sources } = await this.call<{ sources: { id: string; kind: string; url: string | null; mapping: unknown }[] }>(workspaceId, memberId, { method: "GET", path: `${base}/sources` });
    const src = sources.find((x) => x.id === sourceId);
    if (!src) throw new HostedError(404, "No such source.");
    const doFetch = this.deps.fetch ?? fetch;
    const fail = async (message: string) => {
      await this.call(workspaceId, memberId, { method: "POST", path: `${base}/sources/${sourceId}`, body: { lastError: message.slice(0, 500) } });
      return new HostedError(502, message);
    };
    let csv: string;
    if (src.kind === "csv_url" && src.url) {
      const res = await doFetch(src.url, { redirect: "follow", headers: { Accept: "text/csv, text/plain" } }).catch(() => null);
      if (!res || !res.ok) throw await fail(`Could not fetch the CSV link (${res?.status ?? "network error"}).`);
      csv = await res.text();
      if (csv.length > 20_000_000) throw await fail("The CSV is larger than 20 MB.");
    } else if (src.kind === "stripe") {
      const sealed = await this.deps.tenant(workspaceId).getSecret(sourceId);
      if (!sealed) throw new HostedError(409, "Add a Stripe restricted key first.");
      const key = await this.open(sealed, `${workspaceId}/${sourceId}`);
      const lines = ["id,date,amount,currency,customer"];
      let after: string | null = null;
      for (let page = 0; page < 20; page++) {
        const res = await doFetch(`https://api.stripe.com/v1/invoices?status=paid&limit=100${after ? `&starting_after=${after}` : ""}`, { headers: { Authorization: `Bearer ${key}` } }).catch(() => null);
        if (!res || !res.ok) throw await fail(`Stripe refused the request (${res?.status ?? "network error"}). Check the key has read access to invoices.`);
        const body = (await res.json()) as { data: { id: string; amount_paid: number; currency: string; created: number; customer: string | null }[]; has_more: boolean };
        for (const inv of body.data) {
          const cur = inv.currency.toUpperCase();
          const digits = new Intl.NumberFormat("en", { style: "currency", currency: cur }).resolvedOptions().maximumFractionDigits ?? 2;
          lines.push([inv.id, new Date(inv.created * 1000).toISOString().slice(0, 10), (inv.amount_paid / 10 ** digits).toFixed(digits), cur, inv.customer ?? ""].join(","));
        }
        if (!body.has_more || !body.data.length) break;
        after = body.data[body.data.length - 1].id;
      }
      csv = lines.join("\n");
      if (!src.mapping) {
        const me = await this.call<{ profile: { currency: string } }>(workspaceId, memberId, { method: "GET", path: `${base}/me` });
        await this.call(workspaceId, memberId, { method: "POST", path: `${base}/sources/${sourceId}`, body: { mapping: { externalId: "id", occurredAt: "date", amount: "amount", currency: "currency", defaultCurrency: me.profile.currency, extra: { customer: "customer" } } } });
      }
    } else throw new HostedError(409, "This source is filled by uploads, not syncing.");
    const r = await this.call<{ imported: number; preview: { duplicates: unknown[] } }>(workspaceId, memberId, { method: "POST", path: `${base}/sources/${sourceId}/ingest`, body: { csv } });
    return { imported: r.imported, duplicates: r.preview.duplicates.length };
  }

  // ---- documents ----

  private async docOf(user: User, workspaceId: string, docId: string) {
    const { memberId } = await this.memberOr404(user, workspaceId);
    const { documents } = await this.call<{ documents: { id: string; sha256: string; storage: string; mime: string; name: string }[] }>(workspaceId, memberId, { method: "GET", path: `/v1/workspaces/${workspaceId}/documents` });
    const doc = documents.find((d) => d.id === docId);
    if (!doc) throw new HostedError(404, "No such document.");
    return doc;
  }

  async putFile(user: User, workspaceId: string, docId: string, bytes: Uint8Array): Promise<void> {
    if (!this.deps.files) throw new HostedError(500, "File storage is not configured.");
    const doc = await this.docOf(user, workspaceId, docId);
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (doc.storage !== "cloud" || digest !== doc.sha256) throw new HostedError(400, "The file does not match the recorded digest.");
    await this.deps.files.put(`${workspaceId}/${docId}`, bytes);
  }

  async getFile(user: User, workspaceId: string, docId: string): Promise<{ bytes: Uint8Array; mime: string; name: string } | null> {
    if (!this.deps.files) throw new HostedError(500, "File storage is not configured.");
    const doc = await this.docOf(user, workspaceId, docId);
    const bytes = await this.deps.files.get(`${workspaceId}/${docId}`);
    return bytes ? { bytes, mime: doc.mime, name: doc.name } : null;
  }

  async acceptInvite(user: User, code: string): Promise<{ workspaceId: string }> {
    const m = await this.deps.directory.redeem(code, user.sub);
    await this.deps.directory.setLastUsed(user.sub, m.memberId);
    return { workspaceId: m.workspaceId };
  }
}
