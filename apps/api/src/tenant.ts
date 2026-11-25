import { EnterpriseApi } from "@archymedes/engine/api";
import type { EnterpriseState, EntRequest, EntResponse, Role } from "@archymedes/engine/api-types";
import { emptyState } from "@archymedes/engine/host";
import type { WorkspaceSlices } from "@archymedes/engine/templates";
import { loadState, saveState } from "./store";
import type { Kv } from "./store";

export interface Identity {
  id: string;
  name: string;
  title: string;
  role: Role;
  workspaceId: string;
  tenantName: string;
}

/** One company's workspace: the Enterprise API over its own durable store. */
export class TenantCore {
  private api: EnterpriseApi | null = null;
  private loaded = false;

  constructor(
    private readonly kv: Kv,
    private readonly now: () => string,
  ) {}

  private async ensure(): Promise<EnterpriseApi | null> {
    if (!this.loaded) {
      const st = await loadState(this.kv);
      if (st) this.api = new EnterpriseApi(st, { now: this.now });
      this.loaded = true;
    }
    return this.api;
  }

  async exists(): Promise<boolean> {
    return (await this.ensure()) !== null;
  }

  async init(w: WorkspaceSlices): Promise<void> {
    if (await this.ensure()) throw new Error("workspace already exists");
    const st: EnterpriseState = emptyState();
    st.tenants.push(w.tenant);
    st.members.push(...w.members);
    st.profiles.push(w.profile);
    st.policies.push(w.policy);
    st.metrics.push(...w.metrics);
    st.objectives.push(...w.objectives);
    st.rows.push(...w.rows);
    st.imports.push(...w.imports);
    st.decisions.push(...w.decisions);
    st.evaluations.push(...w.evaluations);
    st.approvals.push(...w.approvals);
    st.work.push(...w.work);
    st.evidence.push(...w.evidence);
    st.outcomes.push(...w.outcomes);
    st.moats.push(...w.moats);
    st.forecasts.push(...w.forecasts);
    st.outbox.push(...w.outbox);
    st.tasks = [...(w.tasks ?? [])];
    for (const a of w.audit) st.audit.push({ ...a, seq: ++st.seq });
    this.api = new EnterpriseApi(st, { now: this.now });
    await saveState(this.kv, st);
  }

  /** Connector credentials live beside the workspace, already encrypted by the caller. */
  async setSecret(sourceId: string, sealed: string): Promise<void> {
    await this.kv.put({ [`secret:${sourceId}`]: sealed });
  }

  async getSecret(sourceId: string): Promise<string | null> {
    return (await this.kv.get(`secret:${sourceId}`)) ?? null;
  }

  async identity(memberId: string): Promise<Identity | null> {
    const api = await this.ensure();
    if (!api) return null;
    const st = api.snapshot();
    const m = st.members.find((x) => x.id === memberId);
    const t = m && st.tenants.find((x) => x.id === m.tenantId);
    return m && t ? { id: m.id, name: m.name, title: m.title, role: m.role, workspaceId: t.workspaceId, tenantName: t.name } : null;
  }

  async handle(memberId: string, req: EntRequest): Promise<EntResponse> {
    const api = await this.ensure();
    if (!api) return { status: 404, body: { error: { code: "not_found", message: "No such workspace." } } };
    const res = await api.handle(memberId, req);
    if (req.method !== "GET") {
      await api.runJobs();
      await api.drainOutbox();
      await saveState(this.kv, api.snapshot());
    }
    return res;
  }
}
