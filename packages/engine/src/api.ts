import { MOAT_KINDS } from "./api-types";
import type {
  Approval,
  ApprovalVerdict,
  Decision,
  DecisionDetail,
  DecisionSummary,
  EnterpriseState,
  EntRequest,
  EntResponse,
  Evaluation,
  Evidence,
  KpiCard,
  Member,
  MetricDefinition,
  Objective,
  Outcome,
  Role,
  Source,
  DocumentRecord,
  AttachKind,
  Task,
  TaskStatus,
  Tenant,
  TodayView,
  WorkLink,
  WorkView,
} from "./api-types";
import { previewImport } from "./csv-import";
import { evaluate } from "./evaluator";
import { linearFit, normalCdf, projectPeriod } from "./forecast";
import { brierScore, measureOutcome } from "./measurement";
import { computeMetric, freshness } from "./metrics";
import { advanceMoat, moatPotentialMinor } from "./moat";
import { rankTasks, taskCalibration } from "./compass";
import { goalWinProbability, loopStrength } from "./winning";
import type { LoopCounts, LoopStrength } from "./winning";
import { BuiltInCompass, nextTaskKey } from "./compass-adapter";
import { formatMoney } from "./money";
import { isTimezone, objectiveReadiness } from "./templates";
import type { AlternativeInput, ComparisonMethod, DecisionState, ImportMapping, MetricCalc, MetricFilter, ScenarioInput } from "./types";
import { canTransition } from "./workflow";
import type { CompassAdapter } from "./compass-adapter";
import { buildSnapshot, canonicalJson, currentPolicy, currentProfile, hashSnapshot, sha256 } from "./snapshot";

/** An HTTP-shaped failure. Bodies never carry credentials or provider error text. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const bad = (message: string) => new ApiError(400, "invalid_payload", message);
const forbidden = (message: string, code = "forbidden") => new ApiError(403, code, message);
const notFound = () => new ApiError(404, "not_found", "No such resource in this workspace.");

// ---- payload guards -------------------------------------------------------

type Body = Record<string, unknown>;
const asObj = (v: unknown, name = "body"): Body => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw bad(`${name} must be an object`);
  return v as Body;
};
const str = (b: Body, k: string, max = 2000, optional = false): string => {
  const v = b[k];
  if (v === undefined && optional) return "";
  if (typeof v !== "string" || v.length > max) throw bad(`${k} must be a string up to ${max} characters`);
  return v;
};
const num = (b: Body, k: string, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number => {
  const v = b[k];
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw bad(`${k} must be a number from ${min} to ${max}`);
  return v;
};
const int = (b: Body, k: string, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  const v = num(b, k, min, max);
  if (!Number.isInteger(v)) throw bad(`${k} must be an integer`);
  return v;
};
const oneOf = <T extends string>(b: Body, k: string, options: readonly T[]): T => {
  const v = b[k];
  if (typeof v !== "string" || !options.includes(v as T)) throw bad(`${k} must be one of ${options.join(", ")}`);
  return v as T;
};
const isoDate = (b: Body, k: string): string => {
  const v = str(b, k, 40);
  if (Number.isNaN(Date.parse(v))) throw bad(`${k} must be an ISO date`);
  return new Date(Date.parse(v)).toISOString();
};
const intArray = (b: Body, k: string, maxLen = 100_000): number[] => {
  const v = b[k];
  if (!Array.isArray(v) || v.length === 0 || v.length > maxLen || !v.every((x) => Number.isSafeInteger(x))) throw bad(`${k} must be a non-empty array of integer minor units`);
  return v as number[];
};

function parseAlternatives(v: unknown): AlternativeInput[] {
  if (!Array.isArray(v) || v.length < 2 || v.length > 8) throw bad("alternatives must list the baseline and 1–7 candidates");
  const ids = new Set<string>();
  return v.map((raw, i) => {
    const a = asObj(raw, `alternatives[${i}]`);
    const id = str(a, "id", 80);
    if (!/^[\w-]+$/.test(id) || ids.has(id)) throw bad(`alternatives[${i}].id must be unique and simple`);
    ids.add(id);
    if (!Array.isArray(a.scenarios) || a.scenarios.length < 1 || a.scenarios.length > 6) throw bad(`alternatives[${i}].scenarios must have 1–6 entries`);
    const scenarios: ScenarioInput[] = a.scenarios.map((rs, j) => {
      const s = asObj(rs, `scenarios[${j}]`);
      const nullableNum = (k: string) => (s[k] === null || s[k] === undefined ? null : num(s, k));
      return {
        key: str(s, "key", 40),
        label: str(s, "label", 80),
        probability: nullableNum("probability"),
        revenueMinor: nullableNum("revenueMinor"),
        contributionBeforeCostMinor: nullableNum("contributionBeforeCostMinor"),
        actionCostMinor: nullableNum("actionCostMinor"),
        metricAtDeadline: nullableNum("metricAtDeadline"),
      };
    });
    const assumptions = Array.isArray(a.assumptions)
      ? a.assumptions.slice(0, 20).map((rx) => {
          const x = asObj(rx, "assumption");
          const p = asObj(x.provenance, "provenance");
          return { key: str(x, "key", 60), label: str(x, "label", 120), value: str(x, "value", 200), provenance: { source: str(p, "source", 200), asOf: isoDate(p, "asOf"), origin: oneOf(p, "origin", ["observed", "estimated", "unknown"] as const) } };
        })
      : [];
    const moat = a.moat ? asObj(a.moat, "moat") : null;
    return {
      id,
      name: str(a, "name", 120),
      isBaseline: a.isBaseline === true,
      hypothesis: str(a, "hypothesis", 500, true),
      spendMinor: int(a, "spendMinor", 0),
      timeToEffectDays: int(a, "timeToEffectDays", 0, 3650),
      overlapKey: a.overlapKey === undefined ? undefined : str(a, "overlapKey", 60),
      assumptions,
      moat: moat ? { mechanism: str(moat, "mechanism", 200), pCreatedRetained: num(moat, "pCreatedRetained", 0, 1), conditionalValueMinor: int(moat, "conditionalValueMinor", 0), horizonMonths: int(moat, "horizonMonths", 1, 240) } : undefined,
      scenarios,
    };
  });
}

function parseFilters(v: unknown, name: string): MetricFilter[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 10) throw bad(`${name} must be a list of up to 10 filters`);
  return v.map((f, i) => {
    const o = asObj(f, `${name}[${i}]`);
    return { field: str(o, "field", 60), equals: str(o, "equals", 200) };
  });
}

function parsePart(v: unknown, name: string): { kind: "sum" | "count"; field?: string; filters: MetricFilter[] } {
  const o = asObj(v, name);
  const kind = oneOf(o, "kind", ["sum", "count"] as const);
  return { kind, ...(kind === "sum" ? { field: o.field === undefined ? "amount" : str(o, "field", 60) } : {}), filters: parseFilters(o.filters, `${name}.filters`) };
}

function parseMapping(v: unknown): ImportMapping {
  const m = asObj(v, "mapping");
  const extra = m.extra ? asObj(m.extra, "mapping.extra") : {};
  return {
    externalId: str(m, "externalId", 120),
    occurredAt: str(m, "occurredAt", 120),
    amount: str(m, "amount", 120),
    currency: m.currency === undefined || m.currency === "" ? undefined : str(m, "currency", 120),
    defaultCurrency: str(m, "defaultCurrency", 3),
    extra: Object.fromEntries(Object.entries(extra).filter(([k, val]) => /^\w{1,40}$/.test(k) && typeof val === "string")) as Record<string, string>,
  };
}

function parseCalc(v: unknown): MetricCalc {
  const o = asObj(v, "calc");
  const kind = oneOf(o, "kind", ["sum", "count", "ratio"] as const);
  if (kind === "ratio") return { kind, numerator: parsePart(o.numerator, "calc.numerator"), denominator: parsePart(o.denominator, "calc.denominator") };
  if (kind === "sum") return { kind, field: o.field === undefined ? "amount" : str(o, "field", 60), filters: parseFilters(o.filters, "calc.filters") };
  return { kind, filters: parseFilters(o.filters, "calc.filters") };
}

const MISSING_LABEL: Record<string, string> = { owner: "an owner", source: "a data source", baselinePeriod: "a baseline period", deadline: "a target date", target: "a target" };

// ---- authorization lanes ---------------------------------------------------

type Lane = "read" | "configure" | "decide" | "approve" | "evidence" | "review" | "audit" | "task";
const LANES: Record<Lane, readonly Role[]> = {
  read: ["admin", "executive", "lead", "operator", "finance", "auditor"],
  configure: ["admin"],
  decide: ["lead", "executive", "admin"],
  approve: ["executive", "finance"],
  evidence: ["operator", "lead", "admin"],
  review: ["finance", "executive"],
  audit: ["auditor", "admin", "finance"],
  task: ["admin", "executive", "lead", "operator", "finance"],
};

interface Ctx {
  actor: Member;
  tenant: Tenant;
  correlationId: string;
}

type Handler = (ctx: Ctx, p: Record<string, string>, req: EntRequest, query: URLSearchParams) => EntResponse | Promise<EntResponse>;

const ok = <T>(body: T, status = 200): EntResponse<T> => ({ status, body });
const DAY = 86_400_000;
const EVALUATION_TTL_DAYS = 14;
const MAX_ATTEMPTS = 5;

export interface EnterpriseOptions {
  now: () => string;
  /** Defaults to Compass built into the workspace store. */
  compass?: CompassAdapter;
}

export class EnterpriseApi {
  private readonly routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
  private counter = 0;

  readonly compass: CompassAdapter;

  constructor(
    private state: EnterpriseState,
    private readonly opts: EnterpriseOptions,
  ) {
    this.state.tasks ??= [];
    this.state.sources ??= [];
    this.state.documents ??= [];
    this.compass = opts.compass ?? new BuiltInCompass(() => this.state, opts.now);
    this.register();
  }

  snapshot(): EnterpriseState {
    return this.state;
  }

  // ---- entry point ----

  async handle(actorId: string, req: EntRequest): Promise<EntResponse> {
    try {
      const [rawPath, rawQuery = ""] = req.path.split("?");
      const m = /^\/v1\/workspaces\/([\w-]+)(\/.*)$/.exec(rawPath);
      if (!m) throw notFound();
      const tenant = this.state.tenants.find((t) => t.workspaceId === m[1]);
      const actor = tenant && this.state.members.find((x) => x.id === actorId && x.tenantId === tenant.id);
      // Not a member and nonexistent are indistinguishable.
      if (!tenant || !actor) throw notFound();
      const route = this.routes.find((r) => r.method === req.method && r.pattern.test(m[2]));
      if (!route) throw notFound();
      const values = route.pattern.exec(m[2])!.slice(1);
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(values[i])]));
      const ctx: Ctx = { actor, tenant, correlationId: this.id("cor") };

      if (req.method !== "GET" && req.idempotencyKey) {
        const scope = `${tenant.id}:${actor.id}:${req.idempotencyKey}`;
        const bodyHash = sha256(canonicalJson({ m: req.method, p: rawPath, b: req.body ?? null, r: req.ifRevision ?? null }));
        const prior = this.state.idempotency.find((x) => x.scope === scope);
        if (prior) {
          if (prior.bodyHash !== bodyHash) throw new ApiError(409, "idempotency_conflict", "This idempotency key was used with a different request.");
          return structuredClone(prior.response);
        }
        const res = structuredClone(await route.handler(ctx, params, req, new URLSearchParams(rawQuery)));
        if (res.status < 500) this.state.idempotency.push({ scope, bodyHash, response: structuredClone(res) });
        return res;
      }
      // Responses are copies, as over HTTP: callers never hold live state.
      return structuredClone(await route.handler(ctx, params, req, new URLSearchParams(rawQuery)));
    } catch (e) {
      if (e instanceof ApiError) return { status: e.status, body: { error: { code: e.code, message: e.message } } };
      return { status: 500, body: { error: { code: "internal", message: "Unexpected error." } } };
    }
  }

  // ---- workers ----

  /** Runs queued evaluation jobs (the evaluation worker). */
  async runJobs(): Promise<number> {
    let ran = 0;
    for (const job of this.state.jobs.filter((j) => j.state === "queued")) {
      job.state = "done";
      const ev = this.state.evaluations.find((e) => e.id === job.evaluationId && e.tenantId === job.tenantId);
      if (!ev || ev.status !== "queued") continue;
      const result = evaluate(ev.snapshot);
      ev.result = result;
      ev.status = result.status;
      ev.completedAt = this.opts.now();
      ran++;
      const d = this.state.decisions.find((x) => x.id === ev.decisionId && x.tenantId === ev.tenantId)!;
      if (d.revision !== ev.decisionRevision) continue; // superseded while queued
      if (d.state === "Draft") this.move(d, "Evaluated", "system");
      if (result.status === "needs_evidence" && d.state === "Evaluated") this.move(d, "NeedsEvidence", "system", "Evaluator needs evidence");
      this.emit("decision.evaluated", d.tenantId, d.id, d.revision, `cor-job-${job.id}`);
      this.audit(d.tenantId, "system", "decision.evaluated", `evaluation/${ev.id}`, d.revision, d.revision, `cor-job-${job.id}`, result.status);
    }
    return ran;
  }

  /** Delivers approved work to Compass: reconcile by action ID before every create. */
  async drainOutbox(): Promise<void> {
    const now = Date.parse(this.opts.now());
    for (const action of this.state.outbox.filter((a) => a.state === "pending" && Date.parse(a.nextAttemptAt) <= now)) {
      const d = this.state.decisions.find((x) => x.id === action.decisionId && x.tenantId === action.tenantId)!;
      const work = this.state.work.find((w) => w.id === action.workId && w.tenantId === action.tenantId)!;
      const approvalsActive = action.approvalIds.every((id) => this.state.approvals.find((a) => a.id === id)?.active);
      if (d.revision !== action.decisionRevision || !approvalsActive || d.state !== "Approved") {
        action.state = "cancelled_stale";
        work.state = "cancelled";
        work.blockedReason = "Approval no longer matches the decision revision.";
        this.audit(action.tenantId, "system", "work.cancelled_stale", `work/${work.id}`, action.decisionRevision, d.revision, action.actionId, null);
        continue;
      }
      const tenant = this.state.tenants.find((t) => t.id === action.tenantId)!;
      const ws = tenant.compassWorkspace ?? tenant.workspaceId;
      action.attempts++;
      work.attempts = action.attempts;
      try {
        const task =
          (await this.compass.findTaskByActionId(ws, action.actionId)) ??
          (await this.compass.createTask(ws, { projectId: work.compassProjectId, actionId: action.actionId, title: work.title, doneWhen: work.doneWhen, assignee: work.assigneeId, decisionId: d.id, goalId: d.objectiveId, workId: work.id, dueAt: new Date(now + d.horizonDays * DAY).toISOString() }));
        action.state = "done";
        action.lastError = null;
        work.compassTaskId = task.id;
        work.state = "linked";
        work.lastError = null;
        work.updatedAt = this.opts.now();
        this.move(d, "Executing", "system", `Compass ${task.id}`);
        this.emit("work.linked", d.tenantId, work.id, d.revision, action.actionId);
        this.audit(d.tenantId, "system", "work.linked", `work/${work.id}`, d.revision, d.revision, action.actionId, task.id);
      } catch (e) {
        action.lastError = e instanceof Error ? e.message : "sync failed";
        work.lastError = action.lastError;
        if (action.attempts >= MAX_ATTEMPTS) {
          action.state = "dead";
          work.state = "sync_failed";
        } else {
          action.nextAttemptAt = new Date(now + 30_000 * 2 ** (action.attempts - 1)).toISOString();
          work.state = "sync_pending";
        }
      }
    }
  }

  // ---- helpers ----

  private id(prefix: string): string {
    this.counter++;
    return `${prefix}-${Date.parse(this.opts.now()).toString(36)}-${(this.state.seq + this.counter).toString(36)}`;
  }

  private need(ctx: Ctx, lane: Lane): void {
    if (!LANES[lane].includes(ctx.actor.role)) throw forbidden(`Your role (${ctx.actor.role}) cannot ${lane}.`);
  }

  private audit(tenantId: string, actorId: string, action: string, resource: string, before: number | null, after: number | null, correlationId: string, detail: string | null): void {
    this.state.audit.push({ id: this.id("aud"), tenantId, seq: ++this.state.seq, actorId, action, resource, beforeRevision: before, afterRevision: after, correlationId, at: this.opts.now(), detail });
  }

  private emit(type: string, tenantId: string, aggregateId: string, aggregateVersion: number, correlationId: string): void {
    this.state.events.push({ eventId: this.id("evt"), type, tenantId, timestamp: this.opts.now(), aggregateId, aggregateVersion, schemaVersion: 1, correlationId });
  }

  private move(d: Decision, to: DecisionState, actorId: string, note?: string): void {
    if (d.state === to) return;
    if (!canTransition(d.state, to)) throw new ApiError(409, "invalid_transition", `A decision cannot go from ${d.state} to ${to}.`);
    d.state = to;
    d.updatedAt = this.opts.now();
    d.history.push({ state: to, at: d.updatedAt, actorId, revision: d.revision, note });
  }

  private scoped<T extends { tenantId: string; id: string }>(list: T[], ctx: Ctx, id: string): T {
    const found = list.find((x) => x.id === id && x.tenantId === ctx.tenant.id);
    if (!found) throw notFound();
    return found;
  }

  private checkRevision(req: EntRequest, d: Decision): void {
    if (req.ifRevision === undefined) throw new ApiError(428, "revision_required", "Send ifRevision with this change.");
    if (req.ifRevision !== d.revision) throw new ApiError(412, "stale_revision", `Decision is at revision ${d.revision}, not ${req.ifRevision}.`);
  }

  private memberName(id: string | null): string {
    return this.state.members.find((m) => m.id === id)?.name ?? "—";
  }

  private tenantRows(tenantId: string) {
    return this.state.rows.filter((r) => r.tenantId === tenantId);
  }

  private latestEvaluation(d: Decision): Evaluation | null {
    return this.state.evaluations.find((e) => e.id === d.latestEvaluationId && e.tenantId === d.tenantId) ?? null;
  }

  private summary(d: Decision): DecisionSummary {
    const e = this.latestEvaluation(d);
    const rec = e?.result?.alternatives.find((a) => a.id === (d.chosenAlternativeId ?? e.result!.recommendationId));
    const objective = this.state.objectives.find((o) => o.id === d.objectiveId)!;
    const why: Partial<Record<DecisionState, string>> = {
      Draft: "Draft — evaluate alternatives in Orion",
      Evaluated: "Evaluated — choose an alternative",
      NeedsEvidence: "Orion needs evidence before ranking",
      AwaitingApproval: "Waiting for an approver",
      Approved: "Approved — Compass work syncing",
      Executing: "Work in progress",
      DeliveryReview: "Delivery evidence awaits review",
      Measuring: "Outcome being measured",
    };
    return {
      id: d.id,
      title: d.title,
      state: d.state,
      revision: d.revision,
      ownerName: this.memberName(d.ownerId),
      objectiveName: objective?.name ?? "",
      recommendedName: rec?.name ?? null,
      evContributionMinor: rec?.evContributionMinor ?? null,
      pGoal: rec?.pGoal ?? null,
      closeCall: e?.result?.closeCall ?? false,
      why: why[d.state] ?? d.state,
      updatedAt: d.updatedAt,
    };
  }

  private workView(w: WorkLink): WorkView {
    return {
      ...w,
      decisionTitle: this.state.decisions.find((d) => d.id === w.decisionId)?.title ?? "",
      assigneeName: this.memberName(w.assigneeId),
      evidence: this.state.evidence.filter((e) => e.workId === w.id && e.tenantId === w.tenantId),
    };
  }

  /** Recomputes what a goal still needs; a goal steers rankings only when nothing is missing. */
  private refresh(o: Objective): Objective {
    const metric = this.state.metrics.find((m) => m.id === o.metricId && m.tenantId === o.tenantId);
    o.missing = objectiveReadiness(o, metric, this.tenantRows(o.tenantId).length);
    o.status = o.missing.length ? "draft" : "active";
    return o;
  }

  private kpi(o: Objective): KpiCard {
    this.refresh(o);
    const metric = this.state.metrics.find((m) => m.id === o.metricId && m.tenantId === o.tenantId)!;
    const profile = currentProfile(this.state, o.tenantId);
    const rows = this.tenantRows(o.tenantId);
    const imp = this.state.imports.filter((i) => i.tenantId === o.tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const fresh = metric.source === "not mapped" ? { state: "never" as const, ageHours: null } : freshness(imp?.createdAt ?? null, this.opts.now(), metric.freshnessHours);
    const nowMs = Date.parse(this.opts.now());
    const end = Math.floor(nowMs / DAY) * DAY + DAY;
    const weeks = 26;
    // No records means no observations: show nothing rather than a line of zeros.
    const series = (rows.length === 0 ? [] : Array.from({ length: weeks }, (_, i) => i)).map((i) => {
      const s = end - (weeks - i) * 7 * DAY;
      const v = computeMetric(metric.calc, rows, { start: new Date(s).toISOString(), end: new Date(s + 7 * DAY).toISOString() });
      return v.kind === "value" ? { t: new Date(s).toISOString(), value: v.value } : null;
    }).filter((x): x is { t: string; value: number } => x !== null);
    const recent: ReturnType<typeof computeMetric> = rows.length === 0 ? { kind: "unknown", reason: "no records imported" } : computeMetric(metric.calc, rows, { start: new Date(end - 13 * 7 * DAY).toISOString(), end: new Date(end).toISOString() });
    const actual = recent.kind === "value" ? recent.value : null;
    let forecast: KpiCard["forecast"] = null;
    let projection: KpiCard["projection"] = [];
    if (series.length >= 8 && o.deadline && !(o.direction === "increase" && !(o.targetValue > 0))) {
      const k = Math.max(1, Math.round((Date.parse(o.deadline) - end) / (7 * DAY)));
      if (metric.unit === "money") {
        const p = projectPeriod(series.map((x) => x.value), Math.min(k, 13), o.targetValue);
        if (p) {
          forecast = { value: Math.round(p.value), low: Math.round(p.low), high: Math.round(p.high), pHit: p.pHit };
          projection = p.path.map((v, i) => ({ t: new Date(end + i * 7 * DAY).toISOString(), value: Math.round(v) }));
        }
      } else {
        // A ratio is a level, not a flow: extrapolate the trend to the deadline week.
        const ys = series.map((x) => x.value);
        const { slope, intercept, residualSd } = linearFit(ys);
        const steps = Math.min(k, 13);
        projection = Array.from({ length: steps }, (_, i) => ({ t: new Date(end + i * 7 * DAY).toISOString(), value: intercept + slope * (ys.length + i) }));
        const v = projection[projection.length - 1].value;
        const band = 1.2816 * residualSd;
        const z = residualSd === 0 ? (v >= o.targetValue ? -Infinity : Infinity) : (o.targetValue - v) / residualSd;
        const pAbove = 1 - normalCdf(z);
        forecast = { value: v, low: v - band, high: v + band, pHit: o.direction === "increase" ? pAbove : 1 - pAbove };
      }
    }
    return {
      objectiveId: o.id,
      name: o.name,
      metricName: metric.name,
      unit: metric.unit,
      currency: profile.currency,
      status: o.status,
      direction: o.direction,
      baseline: o.baseline ? { value: o.baseline.value, label: `${o.baseline.periodStart.slice(0, 10)} → ${o.baseline.periodEnd.slice(0, 10)}` } : null,
      target: { value: o.targetValue, deadline: o.deadline },
      actual: metric.unit === "money" ? actual : (series[series.length - 1]?.value ?? (recent.kind === "value" ? recent.value : null)),
      forecast,
      freshness: fresh,
      source: metric.source,
      ownerName: o.ownerId ? this.memberName(o.ownerId) : null,
      series,
      projection,
      definition: metric.description,
      metricVersion: metric.version,
    };
  }

  // ---- imports, sources, documents ----

  private importCsv(ctx: Ctx, csv: string, mapping: ImportMapping, sourceName: string, dryRun: boolean): { preview: ReturnType<typeof previewImport>; imported?: number; importId?: string } {
    const S = this.state;
    const existing = new Set(this.tenantRows(ctx.tenant.id).map((r) => r.externalId));
    const preview = previewImport(csv, mapping, existing, currentProfile(S, ctx.tenant.id).currency);
    if (dryRun) return { preview };
    const importId = this.id("imp");
    for (const r of preview.rows) S.rows.push({ ...r, id: this.id("row"), tenantId: ctx.tenant.id, importId });
    S.imports.push({ id: importId, tenantId: ctx.tenant.id, actorId: ctx.actor.id, source: sourceName, createdAt: this.opts.now(), imported: preview.rows.length, duplicates: preview.duplicates.length, invalid: preview.invalid.length, missing: preview.missing.length });
    this.audit(ctx.tenant.id, ctx.actor.id, "import.committed", `import/${importId}`, null, null, ctx.correlationId, `${preview.rows.length} rows from ${sourceName}`);
    if (preview.rows.length)
      for (const m of S.metrics.filter((x) => x.tenantId === ctx.tenant.id && x.mapsFrom === "billing" && x.source === "not mapped")) {
        m.source = sourceName;
        m.version++;
        this.audit(ctx.tenant.id, ctx.actor.id, "metric.mapped", `metric/${m.id}`, m.version - 1, m.version, ctx.correlationId, m.source);
      }
    return { preview, imported: preview.rows.length, importId };
  }

  private registerSources(): void {
    const S = () => this.state;
    const sources = (t: string) => (S().sources ??= []).filter((x) => x.tenantId === t);
    const docs = (t: string) => (S().documents ??= []).filter((x) => x.tenantId === t);
    this.on("GET", "/sources", (ctx) => ok({ sources: sources(ctx.tenant.id) }));
    this.on("POST", "/sources", (ctx, _p, req) => {
      this.need(ctx, "configure");
      const b = asObj(req.body);
      const kind = oneOf(b, "kind", ["upload", "csv_url", "stripe"] as const);
      let url: string | null = null;
      if (kind === "csv_url") {
        url = str(b, "url", 2000).trim();
        try {
          const u = new URL(url);
          if (u.protocol !== "https:" || u.username || u.password) throw new Error();
        } catch {
          throw bad("url must be an https link to a CSV (for Google Sheets: File → Share → Publish to web → CSV)");
        }
      }
      const src: Source = { id: this.id("src"), tenantId: ctx.tenant.id, kind, name: str(b, "name", 120).trim() || kind, url, mapping: b.mapping === undefined ? null : parseMapping(b.mapping), createdAt: this.opts.now(), createdBy: ctx.actor.id, lastSyncAt: null, lastResult: null, lastError: null, hasSecret: false };
      S().sources!.push(src);
      this.audit(ctx.tenant.id, ctx.actor.id, "source.created", `source/${src.id}`, null, null, ctx.correlationId, `${kind}: ${src.name}`);
      return ok({ source: src }, 201);
    });
    this.on("POST", "/sources/{id}", (ctx, p, req) => {
      this.need(ctx, "configure");
      const src = this.scoped(S().sources!, ctx, p.id);
      const b = asObj(req.body);
      if (b.name !== undefined) src.name = str(b, "name", 120);
      if (b.mapping !== undefined) src.mapping = parseMapping(b.mapping);
      if (b.hasSecret !== undefined) src.hasSecret = b.hasSecret === true;
      if (b.lastError !== undefined) src.lastError = b.lastError === null ? null : str(b, "lastError", 500);
      return ok({ source: src });
    });
    this.on("POST", "/sources/{id}/ingest", (ctx, p, req) => {
      this.need(ctx, "configure");
      const src = this.scoped(S().sources!, ctx, p.id);
      if (!src.mapping) throw new ApiError(409, "mapping_required", "Map the columns before syncing this source.");
      const res = this.importCsv(ctx, str(asObj(req.body), "csv", 20_000_000), src.mapping, src.name, false);
      src.lastSyncAt = this.opts.now();
      src.lastError = null;
      src.lastResult = { imported: res.preview.rows.length, duplicates: res.preview.duplicates.length, invalid: res.preview.invalid.length, missing: res.preview.missing.length };
      return ok({ ...res, source: src });
    });
    this.on("GET", "/documents", (ctx, _p, _r, q) => {
      const kind = (["goal", "decision", "task"] as const).find((k) => q.get(k));
      const list = docs(ctx.tenant.id).filter((d) => !kind || (d.attachedTo?.kind === kind && d.attachedTo.id === q.get(kind)));
      return ok({ documents: [...list].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)).map((d) => ({ ...d, uploadedByName: this.memberName(d.uploadedBy) })) });
    });
    const target = (ctx: Ctx, v: unknown): DocumentRecord["attachedTo"] => {
      if (v === undefined || v === null) return null;
      const o = asObj(v, "attachedTo");
      const kind = oneOf(o, "kind", ["goal", "decision", "task"] as const satisfies readonly AttachKind[]);
      const id = str(o, "id", 80);
      const exists = kind === "goal" ? S().objectives : kind === "decision" ? S().decisions : (S().tasks ?? []);
      this.scoped(exists as { id: string; tenantId: string }[], ctx, id);
      return { kind, id };
    };
    this.on("POST", "/documents", (ctx, _p, req) => {
      this.need(ctx, "task");
      const b = asObj(req.body);
      const sha256 = str(b, "sha256", 64);
      if (!/^[0-9a-f]{64}$/.test(sha256)) throw bad("sha256 must be a hex digest");
      const doc: DocumentRecord = { id: this.id("doc"), tenantId: ctx.tenant.id, name: str(b, "name", 200).trim() || "document", mime: str(b, "mime", 120, true) || "application/octet-stream", size: int(b, "size", 0, 50_000_000), sha256, preview: str(b, "preview", 4000, true).slice(0, 4000), storage: oneOf(b, "storage", ["browser", "cloud"] as const), attachedTo: target(ctx, b.attachedTo), uploadedBy: ctx.actor.id, uploadedAt: this.opts.now() };
      S().documents!.push(doc);
      this.audit(ctx.tenant.id, ctx.actor.id, "document.added", `document/${doc.id}`, null, null, ctx.correlationId, doc.name);
      return ok({ document: doc }, 201);
    });
    this.on("POST", "/documents/{id}/attach", (ctx, p, req) => {
      this.need(ctx, "task");
      const doc = this.scoped(S().documents!, ctx, p.id);
      doc.attachedTo = target(ctx, asObj(req.body).attachedTo);
      return ok({ document: doc });
    });
  }

  // ---- Compass, winning, defensibility ----

  private tasks(tenantId: string): Task[] {
    return (this.state.tasks ??= []).filter((t) => t.tenantId === tenantId);
  }

  private taskView(t: Task, score?: number, reasons?: string[]) {
    return {
      ...t,
      score: score ?? null,
      reasons: reasons ?? [],
      ownerName: t.ownerId ? this.memberName(t.ownerId) : null,
      goalName: t.goalId ? (this.state.objectives.find((o) => o.id === t.goalId)?.name ?? null) : null,
      decisionTitle: t.decisionId ? (this.state.decisions.find((d) => d.id === t.decisionId)?.title ?? null) : null,
    };
  }

  /** Counts behind P(D), P(A|D) and P(L|D,A), from decisions and Compass tasks alike. */
  private loopCounts(tenantId: string): LoopCounts {
    const now = Date.parse(this.opts.now());
    const ds = this.state.decisions.filter((d) => d.tenantId === tenantId);
    const decided = ds.filter((d) => d.history.some((h) => h.state === "AwaitingApproval"));
    const good = decided.filter((d) => {
      const e = this.state.evaluations.find((x) => x.id === d.latestEvaluationId);
      const chosen = e?.result?.alternatives.find((a) => a.id === d.chosenAlternativeId);
      const objective = this.state.objectives.find((o) => o.id === d.objectiveId);
      return e?.status === "complete" && !!chosen?.eligible && objective?.status === "active" && e.result!.alternatives.some((a) => a.isBaseline);
    });
    const approved = ds.filter((d) => d.history.some((h) => h.state === "Approved"));
    const delivered = approved.filter((d) => d.state === "Measuring" || d.state === "Debriefed");
    const overdue = approved.filter((d) => ["Approved", "Executing", "DeliveryReview"].includes(d.state) && now - Date.parse(d.history.find((h) => h.state === "Approved")!.at) > d.horizonDays * DAY);
    const cancelled = approved.filter((d) => d.state === "Cancelled");
    const own = this.tasks(tenantId).filter((t) => !t.decisionId);
    const tasksDone = own.filter((t) => t.status === "done");
    const tasksLate = own.filter((t) => t.status !== "done" && t.dueAt && Date.parse(t.dueAt) < now);
    return {
      decided: decided.length,
      goodDecisions: good.length,
      executed: delivered.length + overdue.length + cancelled.length + tasksDone.length + tasksLate.length,
      delivered: delivered.length + tasksDone.filter((t) => t.evidenceNote).length,
      measurable: delivered.length + tasksDone.length,
      learned: ds.filter((d) => d.state === "Debriefed").length + tasksDone.filter((t) => t.debrief).length,
    };
  }

  private loop(tenantId: string): LoopStrength {
    return loopStrength(this.loopCounts(tenantId));
  }

  private winning(tenantId: string) {
    const loop = this.loop(tenantId);
    const goals = this.state.objectives
      .filter((o) => o.tenantId === tenantId)
      .map((o) => {
        const k = this.kpi(o);
        if (k.status !== "active" || !k.forecast) return { objectiveId: o.id, name: o.name, pWin: k.status === "active" && k.forecast === null ? null : null, pWinTrendOnly: null, initiatives: 0, unit: k.unit };
        const sd = Math.max(1e-9, (k.forecast.high - k.forecast.value) / 1.2816);
        const g = { mean: k.forecast.value, sd, target: o.targetValue, direction: o.direction };
        const committed = this.state.decisions.filter((d) => d.tenantId === tenantId && d.objectiveId === o.id && ["Approved", "Executing", "DeliveryReview", "Measuring"].includes(d.state));
        const initiatives =
          k.unit === "money"
            ? committed.flatMap((d) => {
                const a = this.state.evaluations.find((e) => e.id === d.latestEvaluationId)?.result?.alternatives.find((x) => x.id === d.chosenAlternativeId);
                if (!a || a.evRevenueMinor === null) return [];
                const variance = a.scenarios.reduce((s, sc) => s + sc.probability * (sc.deltaRevenueMinor - a.evRevenueMinor!) ** 2, 0);
                return [{ ev: a.evRevenueMinor, variance, pExec: d.state === "Measuring" ? 1 : loop.pAgivenD }];
              })
            : [];
        return { objectiveId: o.id, name: o.name, pWin: goalWinProbability(g, initiatives), pWinTrendOnly: goalWinProbability(g, []), initiatives: initiatives.length, unit: k.unit };
      });
    return { loop, goals };
  }

  private gettingStarted(tenantId: string) {
    const st = this.state;
    const tasks = this.tasks(tenantId);
    const steps = [
      { key: "data", label: "Connect your data", hint: "Import a billing or orders CSV so goals are measured, not guessed.", done: st.rows.some((r) => r.tenantId === tenantId) },
      { key: "goal", label: "Confirm a measurable goal", hint: "Give it an owner, a baseline, a target and a date.", done: st.objectives.some((o) => o.tenantId === tenantId && o.status === "active") },
      { key: "team", label: "Invite your team", hint: "Decisions need an independent approver; work needs owners.", done: st.members.filter((m) => m.tenantId === tenantId).length >= 2 },
      { key: "compare", label: "Compare options in Orion", hint: "List what you could do, plus doing nothing, and record what you expect.", done: st.evaluations.some((e) => e.tenantId === tenantId && e.status === "complete") },
      { key: "approve", label: "Approve a decision", hint: "Someone other than the proposer signs off on the numbers they saw.", done: st.approvals.some((a) => a.tenantId === tenantId && a.verdict === "approve") },
      { key: "deliver", label: "Finish a task with proof", hint: "Compass tracks the owner, the blockers and the evidence it was delivered.", done: tasks.some((t) => t.status === "done") || st.work.some((w) => w.tenantId === tenantId && w.state === "verified") },
      { key: "learn", label: "Close the loop", hint: "Compare what happened with the forecast, and note what the cycle left behind.", done: st.outcomes.some((o) => o.tenantId === tenantId && o.status !== "pending_review") || tasks.some((t) => t.debrief) },
    ];
    return steps;
  }

  private defensibility(tenantId: string) {
    const moats = this.state.moats.filter((m) => m.tenantId === tenantId);
    const byKind: Record<string, number> = {};
    for (const m of moats) byKind[m.kind ?? "know_how"] = (byKind[m.kind ?? "know_how"] ?? 0) + 1;
    const pairs = this.state.forecasts.filter((f) => f.tenantId === tenantId).length + this.tasks(tenantId).filter((t) => t.debrief).length;
    // Cycles: each closed decision or debriefed task, in time order, with the advantage stacked so far.
    const closed = [
      ...this.state.outcomes.filter((o) => o.tenantId === tenantId && o.status !== "pending_review" && o.reviewedAt).map((o) => ({ at: o.reviewedAt!, title: this.state.decisions.find((d) => d.id === o.decisionId)?.title ?? "", ref: o.decisionId })),
      ...this.tasks(tenantId).filter((t) => t.debrief).map((t) => ({ at: t.debrief!.at, title: t.title, ref: t.id })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    let assets = 0;
    let value = 0;
    const cycles = closed.map((c, i) => {
      const left = moats.filter((m) => m.decisionId === c.ref || m.taskId === c.ref);
      assets += left.length;
      value += left.reduce((s, m) => s + (m.realizedMinor ?? moatPotentialMinor(m)), 0);
      return { cycle: i + 1, at: c.at, title: c.title, assetsLeft: left.map((m) => m.mechanism), cumulativeAssets: assets, cumulativeValueMinor: value };
    });
    return { assets: moats.length, byKind, decisionDataPairs: pairs, cycles, taskCalibration: taskCalibration(this.tasks(tenantId)) };
  }

  private taskFor(ctx: Ctx, id: string, edit = true): Task {
    const t = this.tasks(ctx.tenant.id).find((x) => x.id === id);
    if (!t) throw notFound();
    if (edit && ctx.actor.role === "operator" && t.ownerId && t.ownerId !== ctx.actor.id) throw forbidden("Operators can change only their own or unassigned tasks.");
    return t;
  }

  private touch(t: Task, ctx: Ctx, action: string, detail: string | null = null): void {
    t.updatedAt = this.opts.now();
    t.revision++;
    this.audit(ctx.tenant.id, ctx.actor.id, action, `task/${t.id}`, t.revision - 1, t.revision, ctx.correlationId, detail);
  }

  private registerTasks(): void {
    const parseMoat = (v: unknown): Task["moat"] => {
      if (v === undefined || v === null) return null;
      const m = asObj(v, "moat");
      return { kind: oneOf(m, "kind", MOAT_KINDS.map((k) => k.kind)), note: str(m, "note", 300, true), strength: int(m, "strength", 0, 5) };
    };
    const strList = (v: unknown, name: string): string[] => {
      if (v === undefined) return [];
      if (!Array.isArray(v) || v.length > 20 || !v.every((x) => typeof x === "string" && x.length <= 300)) throw bad(`${name} must be a list of short texts`);
      return (v as string[]).map((x) => x.trim()).filter(Boolean);
    };
    this.on("GET", "/tasks", (ctx) => {
      const all = this.tasks(ctx.tenant.id);
      const ranked = rankTasks(all, this.opts.now()).map((r) => this.taskView(r.task, r.score, r.reasons));
      const done = all.filter((t) => t.status === "done").sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? "")).map((t) => this.taskView(t));
      return ok({ tasks: [...ranked, ...done], calibration: taskCalibration(all) });
    });
    this.on("POST", "/tasks", (ctx, _p, req) => {
      this.need(ctx, "task");
      const b = asObj(req.body);
      const now = this.opts.now();
      const ownerId = b.ownerId ? this.scoped(this.state.members, ctx, str(b, "ownerId", 80)).id : ctx.actor.role === "operator" ? ctx.actor.id : null;
      const t: Task = {
        id: this.id("task"),
        key: nextTaskKey(this.state, ctx.tenant.id),
        tenantId: ctx.tenant.id,
        title: str(b, "title", 200).trim() || (() => { throw bad("title must not be empty"); })(),
        description: str(b, "description", 4000, true),
        status: "todo",
        ownerId,
        createdBy: ctx.actor.id,
        doneWhen: strList(b.doneWhen, "doneWhen"),
        dueAt: b.dueAt ? isoDate(b, "dueAt") : null,
        goalId: b.goalId ? this.scoped(this.state.objectives, ctx, str(b, "goalId", 80)).id : null,
        decisionId: null,
        workId: null,
        actionId: null,
        impact: b.impact === undefined ? 3 : int(b, "impact", 1, 5),
        confidence: b.confidence === undefined ? 0.5 : num(b, "confidence", 0, 1),
        effortDays: b.effortDays === undefined ? 2 : num(b, "effortDays", 0.1, 365),
        moat: parseMoat(b.moat),
        blockers: [],
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        completedAt: null,
        evidenceNote: null,
        debrief: null,
        revision: 1,
      };
      this.state.tasks!.push(t);
      this.audit(ctx.tenant.id, ctx.actor.id, "task.created", `task/${t.id}`, null, 1, ctx.correlationId, t.title);
      return ok({ task: this.taskView(t) }, 201);
    });
    this.on("POST", "/tasks/{id}", (ctx, p, req) => {
      this.need(ctx, "task");
      const t = this.taskFor(ctx, p.id);
      if (req.ifRevision !== undefined && req.ifRevision !== t.revision) throw new ApiError(412, "stale_revision", `Task is at revision ${t.revision}.`);
      const b = asObj(req.body);
      if (b.title !== undefined) t.title = str(b, "title", 200);
      if (b.description !== undefined) t.description = str(b, "description", 4000);
      if (b.ownerId !== undefined) t.ownerId = b.ownerId === null ? null : this.scoped(this.state.members, ctx, str(b, "ownerId", 80)).id;
      if (b.doneWhen !== undefined) t.doneWhen = strList(b.doneWhen, "doneWhen");
      if (b.dueAt !== undefined) t.dueAt = b.dueAt === null ? null : isoDate(b, "dueAt");
      if (b.goalId !== undefined) t.goalId = b.goalId === null ? null : this.scoped(this.state.objectives, ctx, str(b, "goalId", 80)).id;
      if (b.impact !== undefined) t.impact = int(b, "impact", 1, 5);
      if (b.confidence !== undefined) t.confidence = num(b, "confidence", 0, 1);
      if (b.effortDays !== undefined) t.effortDays = num(b, "effortDays", 0.1, 365);
      if (b.moat !== undefined) t.moat = parseMoat(b.moat);
      if (b.status !== undefined) {
        const status = oneOf(b, "status", ["todo", "doing", "blocked"] as const satisfies readonly TaskStatus[]);
        if (t.status === "done") throw new ApiError(409, "invalid_transition", "This task is done; add a new task instead.");
        t.status = status;
        if (status === "doing") t.startedAt ??= this.opts.now();
      }
      this.touch(t, ctx, "task.updated", t.status);
      return ok({ task: this.taskView(t) });
    });
    this.on("POST", "/tasks/{id}/blockers", (ctx, p, req) => {
      this.need(ctx, "task");
      const t = this.taskFor(ctx, p.id);
      const text = str(asObj(req.body), "text", 300).trim();
      if (!text) throw bad("text must not be empty");
      t.blockers.push({ id: this.id("blk"), text, createdAt: this.opts.now(), resolvedAt: null });
      if (t.status !== "done") t.status = "blocked";
      this.touch(t, ctx, "task.blocked", text);
      return ok({ task: this.taskView(t) }, 201);
    });
    this.on("POST", "/tasks/{id}/blockers/{bid}/resolve", (ctx, p) => {
      this.need(ctx, "task");
      const t = this.taskFor(ctx, p.id);
      const blk = t.blockers.find((x) => x.id === p.bid);
      if (!blk) throw notFound();
      blk.resolvedAt ??= this.opts.now();
      if (t.status === "blocked" && t.blockers.every((x) => x.resolvedAt)) {
        t.status = "doing";
        t.startedAt ??= this.opts.now();
      }
      this.touch(t, ctx, "task.unblocked", blk.text);
      return ok({ task: this.taskView(t) });
    });
    this.on("POST", "/tasks/{id}/done", (ctx, p, req) => {
      this.need(ctx, "task");
      const t = this.taskFor(ctx, p.id);
      if (t.workId) throw new ApiError(409, "linked_to_decision", "This task delivers an approved decision: submit delivery evidence on the Work page so a reviewer can verify it.");
      if (t.status === "done") throw new ApiError(409, "invalid_transition", "Already done.");
      const b = asObj(req.body ?? {});
      const evidence = b.evidenceNote === undefined ? "" : str(b, "evidenceNote", 2000).trim();
      if (!evidence) throw bad("evidenceNote must say how the delivery can be verified");
      Object.assign(t, { status: "done", completedAt: this.opts.now(), evidenceNote: evidence });
      for (const blk of t.blockers) blk.resolvedAt ??= this.opts.now();
      this.touch(t, ctx, "task.done", evidence);
      return ok({ task: this.taskView(t) });
    });
    this.on("POST", "/tasks/{id}/debrief", (ctx, p, req) => {
      this.need(ctx, "task");
      const t = this.taskFor(ctx, p.id);
      if (t.status !== "done") throw new ApiError(409, "invalid_transition", "Debrief a task once it is done.");
      const b = asObj(req.body);
      const assetLeft = b.assetLeft === undefined ? "" : str(b, "assetLeft", 300).trim();
      t.debrief = { actualImpact: int(b, "actualImpact", 1, 5), lesson: str(b, "lesson", 2000, true), assetLeft: assetLeft || null, at: this.opts.now(), by: ctx.actor.id };
      if (assetLeft)
        this.state.moats.push({ id: this.id("moat"), tenantId: t.tenantId, decisionId: t.decisionId ?? "", taskId: t.id, kind: b.assetKind === undefined ? (t.moat?.kind ?? "know_how") : oneOf(b, "assetKind", MOAT_KINDS.map((k) => k.kind)), mechanism: assetLeft, ownerId: ctx.actor.id, horizonMonths: 12, stage: "created", pCreatedRetained: 0.5, conditionalValueMinor: 0, evidence: [t.evidenceNote ?? ""], realizedMinor: null });
      this.touch(t, ctx, "task.debriefed", t.debrief.lesson);
      return ok({ task: this.taskView(t) });
    });
  }

  // ---- routes ----

  private on(method: string, path: string, handler: Handler): void {
    const keys: string[] = [];
    const pattern = new RegExp(
      "^" +
        path.replace(/\{(\w+)\}/g, (_, k) => {
          keys.push(k);
          return "([\\w.-]+)";
        }) +
        "$",
    );
    this.routes.push({ method, pattern, keys, handler });
  }

  private register(): void {
    const S = () => this.state;

    this.on("GET", "/me", (ctx) => ok({ me: ctx.actor, tenant: ctx.tenant, profile: currentProfile(S(), ctx.tenant.id), policy: currentPolicy(S(), ctx.tenant.id), compass: this.compass.kind }));
    this.on("GET", "/members", (ctx) => ok({ members: S().members.filter((m) => m.tenantId === ctx.tenant.id) }));
    this.on("POST", "/members", (ctx, _p, req) => {
      this.need(ctx, "configure");
      const b = asObj(req.body);
      const member: Member = {
        id: this.id("u"),
        tenantId: ctx.tenant.id,
        name: str(b, "name", 120).trim() || (() => { throw bad("name must not be empty"); })(),
        title: str(b, "title", 120, true),
        role: oneOf(b, "role", ["admin", "executive", "lead", "operator", "finance", "auditor"] as const),
        department: str(b, "department", 80, true),
      };
      S().members.push(member);
      this.audit(ctx.tenant.id, ctx.actor.id, "member.added", `member/${member.id}`, null, null, ctx.correlationId, `${member.name} as ${member.role}`);
      return ok({ member }, 201);
    });
    this.on("POST", "/profile", (ctx, _p, req) => {
      this.need(ctx, "configure");
      const b = asObj(req.body);
      const cur = currentProfile(S(), ctx.tenant.id);
      const next = { ...cur, version: cur.version + 1, createdAt: this.opts.now() };
      if (b.name !== undefined) next.name = str(b, "name", 120).trim() || (() => { throw bad("name must not be empty"); })();
      if (b.timezone !== undefined) {
        const tz = str(b, "timezone", 64);
        if (!isTimezone(tz)) throw bad("timezone must be an IANA zone like Europe/Paris");
        next.timezone = tz;
      }
      if (b.fiscalYearStartMonth !== undefined) next.fiscalYearStartMonth = int(b, "fiscalYearStartMonth", 1, 12);
      if (b.grossMarginBps !== undefined) next.grossMarginBps = b.grossMarginBps === null ? null : int(b, "grossMarginBps", 0, 10_000);
      if (b.aiDataPolicy !== undefined) next.aiDataPolicy = oneOf(b, "aiDataPolicy", ["none", "aggregates_only", "redacted_records"] as const);
      if (b.departments !== undefined) {
        if (!Array.isArray(b.departments) || !b.departments.every((x) => typeof x === "string" && x.length <= 80)) throw bad("departments must be a list of names");
        next.departments = (b.departments as string[]).slice(0, 30);
      }
      if (b.currency !== undefined && b.currency !== cur.currency) throw bad("currency is fixed once a workspace has data; create a new workspace to change it");
      S().profiles.push(next);
      ctx.tenant.name = next.name;
      this.audit(ctx.tenant.id, ctx.actor.id, "profile.versioned", `profile/v${next.version}`, cur.version, next.version, ctx.correlationId, "applies prospectively");
      return ok({ profile: next }, 201);
    });
    this.on("POST", "/metrics", (ctx, _p, req) => {
      this.need(ctx, "configure");
      const b = asObj(req.body);
      const mapsFrom = b.mapsFrom === undefined ? undefined : oneOf(b, "mapsFrom", ["billing"] as const);
      const metric: MetricDefinition = {
        id: this.id("met"),
        tenantId: ctx.tenant.id,
        version: 1,
        name: str(b, "name", 120),
        description: str(b, "description", 500, true),
        unit: oneOf(b, "unit", ["money", "count", "ratio"] as const),
        calc: parseCalc(b.calc),
        grain: b.grain === undefined ? "week" : oneOf(b, "grain", ["week", "month"] as const),
        ownerId: ctx.actor.id,
        source: mapsFrom ? "not mapped" : "manual",
        freshnessHours: b.freshnessHours === undefined ? 36 : int(b, "freshnessHours", 1, 24 * 90),
        ...(mapsFrom ? { mapsFrom } : {}),
      };
      S().metrics.push(metric);
      this.audit(ctx.tenant.id, ctx.actor.id, "metric.created", `metric/${metric.id}`, null, 1, ctx.correlationId, metric.name);
      return ok({ metric }, 201);
    });

    this.on("GET", "/today", (ctx) => {
      const t = ctx.tenant.id;
      const decisions = S().decisions.filter((d) => d.tenantId === t);
      const role = ctx.actor.role;
      const needsMe = (d: Decision) => {
        if (d.state === "AwaitingApproval") return LANES.approve.includes(role) && d.ownerId !== ctx.actor.id;
        if (d.state === "DeliveryReview") return LANES.review.includes(role);
        if (d.state === "Measuring") return LANES.review.includes(role) || d.ownerId === ctx.actor.id;
        if (["Draft", "Evaluated", "NeedsEvidence", "Rejected"].includes(d.state)) return d.ownerId === ctx.actor.id || role === "executive";
        return false;
      };
      const order: DecisionState[] = ["AwaitingApproval", "DeliveryReview", "NeedsEvidence", "Measuring", "Evaluated", "Draft", "Rejected"];
      const attention = decisions
        .filter(needsMe)
        .sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state))
        .map((d) => this.summary(d));
      const work = S()
        .work.filter((w) => w.tenantId === t && (role === "operator" ? w.assigneeId === ctx.actor.id : true) && w.state !== "verified" && w.state !== "cancelled")
        .map((w) => this.workView(w));
      const blockers = [
        ...S().work.filter((w) => w.tenantId === t && (w.state === "sync_failed" || w.state === "sync_pending" || w.blockedReason)).map((w) => `${w.title}: ${w.state === "sync_failed" ? "Compass sync failed — requeue" : (w.blockedReason ?? "Compass sync pending")}`),
        ...S()
          .objectives.filter((o) => o.tenantId === t)
          .map((o) => this.refresh(o))
          .filter((o) => o.status === "draft")
          .map((o) => `${o.name}: needs ${o.missing.map((k) => MISSING_LABEL[k] ?? k).join(", ")} before it can steer rankings`),
      ];
      const fc = S().forecasts.filter((f) => f.tenantId === t);
      const moats = S().moats.filter((m) => m.tenantId === t);
      const view: TodayView = {
        me: ctx.actor,
        tenant: ctx.tenant,
        profile: currentProfile(S(), t),
        kpis: S().objectives.filter((o) => o.tenantId === t).map((o) => this.kpi(o)),
        attention,
        work,
        outcomes: S()
          .outcomes.filter((o) => o.tenantId === t)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((o) => ({ ...o, decisionTitle: S().decisions.find((d) => d.id === o.decisionId)?.title ?? "" })),
        blockers,
        calibration: { ...brierScore(fc.map((f) => ({ p: f.p, outcome: f.outcome }))), points: fc },
        moat: {
          proposedMinor: moats.filter((m) => m.stage === "proposed" || m.stage === "created").reduce((s, m) => s + moatPotentialMinor({ ...m, mechanism: m.mechanism }), 0),
          verifiedMinor: moats.filter((m) => m.stage === "verified").reduce((s, m) => s + moatPotentialMinor(m), 0),
          realizedMinor: moats.reduce((s, m) => s + (m.realizedMinor ?? 0), 0),
          assets: moats.length,
        },
        winning: this.winning(t),
        gettingStarted: this.gettingStarted(t),
        defensibility: this.defensibility(t),
        tasks: rankTasks(this.tasks(t), this.opts.now())
          .slice(0, 5)
          .map((r) => this.taskView(r.task, r.score, r.reasons)),
      };
      return ok(view);
    });

    // ---- goals & metrics ----
    this.on("GET", "/objectives", (ctx) => ok({ objectives: S().objectives.filter((o) => o.tenantId === ctx.tenant.id).map((o) => this.refresh(o)), kpis: S().objectives.filter((o) => o.tenantId === ctx.tenant.id).map((o) => this.kpi(o)) }));
    this.on("GET", "/metrics", (ctx) => ok({ metrics: S().metrics.filter((m) => m.tenantId === ctx.tenant.id) }));
    this.on("POST", "/objectives", (ctx, _p, req) => {
      this.need(ctx, "configure");
      const b = asObj(req.body);
      const metric: MetricDefinition = this.scoped(S().metrics, ctx, str(b, "metricId", 80));
      const baseline = b.baseline ? asObj(b.baseline, "baseline") : null;
      const o: Objective = {
        id: this.id("obj"),
        tenantId: ctx.tenant.id,
        version: 1,
        name: str(b, "name", 160),
        metricId: metric.id,
        direction: oneOf(b, "direction", ["increase", "decrease"] as const),
        baseline: baseline ? { value: num(baseline, "value"), periodStart: isoDate(baseline, "periodStart"), periodEnd: isoDate(baseline, "periodEnd") } : null,
        targetValue: num(b, "targetValue"),
        deadline: b.deadline ? isoDate(b, "deadline") : null,
        ownerId: b.ownerId ? this.scoped(S().members, ctx, str(b, "ownerId", 80)).id : null,
        guardrails: Array.isArray(b.guardrails) ? b.guardrails.filter((x): x is string => typeof x === "string").slice(0, 10) : [],
        leadingIndicators: Array.isArray(b.leadingIndicators) ? b.leadingIndicators.filter((x): x is string => typeof x === "string").slice(0, 10) : [],
        interventionGoal: { basis: "incremental_revenue", direction: "increase", target: b.interventionTargetMinor === undefined ? 1_000_000 : int(b, "interventionTargetMinor", 1), label: "" },
        status: "draft",
        missing: [],
        createdAt: this.opts.now(),
      };
      o.interventionGoal.label = `≥ ${formatMoney(o.interventionGoal.target, currentProfile(S(), ctx.tenant.id).currency)} incremental revenue`;
      this.refresh(o);
      S().objectives.push(o);
      this.audit(ctx.tenant.id, ctx.actor.id, "objective.created", `objective/${o.id}`, null, 1, ctx.correlationId, o.status);
      return ok({ objective: o }, 201);
    });
    this.on("POST", "/objectives/{id}", (ctx, p, req) => {
      this.need(ctx, "configure");
      const o = this.scoped(S().objectives, ctx, p.id);
      const b = asObj(req.body);
      if (b.name !== undefined) o.name = str(b, "name", 160);
      if (b.targetValue !== undefined) o.targetValue = num(b, "targetValue");
      if (b.deadline !== undefined) o.deadline = b.deadline === null ? null : isoDate(b, "deadline");
      if (b.ownerId !== undefined) o.ownerId = b.ownerId === null ? null : this.scoped(S().members, ctx, str(b, "ownerId", 80)).id;
      if (b.direction !== undefined) o.direction = oneOf(b, "direction", ["increase", "decrease"] as const);
      if (b.guardrails !== undefined) o.guardrails = Array.isArray(b.guardrails) ? b.guardrails.filter((x): x is string => typeof x === "string").slice(0, 10) : o.guardrails;
      if (b.leadingIndicators !== undefined) o.leadingIndicators = Array.isArray(b.leadingIndicators) ? b.leadingIndicators.filter((x): x is string => typeof x === "string").slice(0, 10) : o.leadingIndicators;
      if (b.interventionTargetMinor !== undefined) {
        o.interventionGoal = { ...o.interventionGoal, target: int(b, "interventionTargetMinor", 1) };
        o.interventionGoal.label = `≥ ${formatMoney(o.interventionGoal.target, currentProfile(S(), ctx.tenant.id).currency)} incremental revenue`;
      }
      if (b.baseline !== undefined) {
        const bl = asObj(b.baseline, "baseline");
        o.baseline = { value: num(bl, "value"), periodStart: isoDate(bl, "periodStart"), periodEnd: isoDate(bl, "periodEnd") };
      }
      if (b.baselineFromData !== undefined) {
        const weeks = int(asObj(b.baselineFromData, "baselineFromData"), "weeks", 1, 104);
        const metric = this.scoped(S().metrics, ctx, o.metricId);
        const end = Math.floor(Date.parse(this.opts.now()) / DAY) * DAY + DAY;
        const window = { start: new Date(end - weeks * 7 * DAY).toISOString(), end: new Date(end).toISOString() };
        const v = computeMetric(metric.calc, this.tenantRows(ctx.tenant.id), window);
        if (v.kind === "unknown") throw new ApiError(409, "baseline_unknown", `No baseline from data: ${v.reason}.`);
        o.baseline = { value: v.value, periodStart: window.start, periodEnd: window.end };
      }
      o.version++;
      this.refresh(o);
      this.audit(ctx.tenant.id, ctx.actor.id, "objective.updated", `objective/${o.id}`, o.version - 1, o.version, ctx.correlationId, o.status);
      return ok({ objective: o });
    });

    // ---- imports ----
    this.on("GET", "/source-rows", (ctx) => {
      const rows = this.tenantRows(ctx.tenant.id);
      return ok({ total: rows.length, rows: rows.slice(-200), imports: S().imports.filter((i) => i.tenantId === ctx.tenant.id) });
    });
    this.on("POST", "/imports", (ctx, _p, req) => {
      this.need(ctx, "configure");
      const b = asObj(req.body);
      const res = this.importCsv(ctx, str(b, "csv", 20_000_000), parseMapping(b.mapping), typeof b.source === "string" ? b.source.slice(0, 120) : "upload.csv", b.dryRun !== false);
      return ok(res, res.importId ? 201 : 200);
    });

    // ---- decisions ----
    this.on("GET", "/decisions", (ctx) => ok({ decisions: S().decisions.filter((d) => d.tenantId === ctx.tenant.id).map((d) => this.summary(d)) }));
    this.on("GET", "/decisions/{id}", (ctx, p) => {
      const d = this.scoped(S().decisions, ctx, p.id);
      const policy = currentPolicy(S(), ctx.tenant.id);
      const detail: DecisionDetail = {
        decision: d,
        objective: S().objectives.find((o) => o.id === d.objectiveId)!,
        evaluations: S().evaluations.filter((e) => e.decisionId === d.id && e.tenantId === d.tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        approvals: S().approvals.filter((a) => a.decisionId === d.id && a.tenantId === d.tenantId),
        work: S().work.filter((w) => w.decisionId === d.id && w.tenantId === d.tenantId).map((w) => this.workView(w)),
        outcomes: S().outcomes.filter((o) => o.decisionId === d.id && o.tenantId === d.tenantId),
        moats: S().moats.filter((m) => m.decisionId === d.id && m.tenantId === d.tenantId),
        policy,
        canApprove: d.state === "AwaitingApproval" && LANES.approve.includes(ctx.actor.role) && !(policy.requireIndependentApprover && d.ownerId === ctx.actor.id),
        canEdit: LANES.decide.includes(ctx.actor.role) && canTransition(d.state, "Draft"),
      };
      return ok(detail);
    });
    this.on("POST", "/decisions", (ctx, _p, req) => {
      this.need(ctx, "decide");
      const b = asObj(req.body);
      const objective = this.scoped(S().objectives, ctx, str(b, "objectiveId", 80));
      const alternatives = parseAlternatives(b.alternatives);
      if (alternatives.filter((a) => a.isBaseline).length !== 1) throw bad("exactly one alternative must be the no-change baseline");
      const now = this.opts.now();
      const d: Decision = {
        id: this.id("dec"),
        tenantId: ctx.tenant.id,
        objectiveId: objective.id,
        title: str(b, "title", 160),
        hypothesis: str(b, "hypothesis", 1000, true),
        ownerId: ctx.actor.id,
        state: "Draft",
        revision: 1,
        alternatives,
        horizonDays: int(b, "horizonDays", 1, 1095),
        cohortSize: int(b, "cohortSize", 0),
        chosenAlternativeId: null,
        rationale: null,
        override: false,
        latestEvaluationId: null,
        cancelledReason: null,
        history: [{ state: "Draft", at: now, actorId: ctx.actor.id, revision: 1 }],
        createdAt: now,
        updatedAt: now,
      };
      S().decisions.push(d);
      for (const a of alternatives.filter((x) => x.moat))
        S().moats.push({ id: this.id("moat"), tenantId: d.tenantId, decisionId: d.id, mechanism: a.moat!.mechanism, ownerId: ctx.actor.id, horizonMonths: a.moat!.horizonMonths, stage: "proposed", pCreatedRetained: a.moat!.pCreatedRetained, conditionalValueMinor: a.moat!.conditionalValueMinor, evidence: [], realizedMinor: null });
      this.audit(d.tenantId, ctx.actor.id, "decision.created", `decision/${d.id}`, null, 1, ctx.correlationId, null);
      return ok({ decision: d }, 201);
    });
    this.on("PATCH", "/decisions/{id}", (ctx, p, req) => {
      this.need(ctx, "decide");
      const d = this.scoped(S().decisions, ctx, p.id);
      this.checkRevision(req, d);
      const b = asObj(req.body);
      if (d.state !== "Draft" && !canTransition(d.state, "Draft")) throw new ApiError(409, "invalid_transition", `A ${d.state} decision can no longer be edited.`);
      const before = d.revision;
      if (b.alternatives !== undefined) d.alternatives = parseAlternatives(b.alternatives);
      if (b.title !== undefined) d.title = str(b, "title", 160);
      if (b.hypothesis !== undefined) d.hypothesis = str(b, "hypothesis", 1000);
      if (b.horizonDays !== undefined) d.horizonDays = int(b, "horizonDays", 1, 1095);
      if (b.cohortSize !== undefined) d.cohortSize = int(b, "cohortSize", 0);
      d.revision++;
      d.chosenAlternativeId = null;
      d.rationale = null;
      d.override = false;
      // A material change invalidates every outstanding approval and queued dispatch for the old revision.
      for (const a of S().approvals.filter((x) => x.decisionId === d.id && x.tenantId === d.tenantId && x.active)) a.active = false;
      for (const o of S().outbox.filter((x) => x.decisionId === d.id && x.tenantId === d.tenantId && x.state === "pending")) {
        o.state = "cancelled_stale";
        const w = S().work.find((x) => x.id === o.workId);
        if (w) {
          w.state = "cancelled";
          w.blockedReason = "Superseded by a new decision revision.";
        }
      }
      this.move(d, "Draft", ctx.actor.id, `revision ${d.revision}`);
      d.history[d.history.length - 1].revision = d.revision;
      this.audit(d.tenantId, ctx.actor.id, "decision.revised", `decision/${d.id}`, before, d.revision, ctx.correlationId, null);
      return ok({ decision: d });
    });
    this.on("POST", "/decisions/{id}/evaluations", (ctx, p) => {
      this.need(ctx, "decide");
      const d = this.scoped(S().decisions, ctx, p.id);
      const objective = this.scoped(S().objectives, ctx, d.objectiveId);
      this.refresh(objective);
      if (objective.status !== "active") throw forbidden(`Objective "${objective.name}" needs ${objective.missing.join(", ")} before it can steer rankings.`, "objective_inactive");
      if (!["Draft", "Evaluated", "NeedsEvidence"].includes(d.state)) throw new ApiError(409, "invalid_transition", `A ${d.state} decision cannot be re-evaluated; revise it first.`);
      if (d.state === "NeedsEvidence") this.move(d, "Draft", ctx.actor.id, "re-evaluating");
      const now = this.opts.now();
      const { snapshot, policyVersion } = buildSnapshot(S(), d, objective, now);
      // P(Win | π, E): give Orion where the goal is heading and how reliably this team executes.
      const k = this.kpi(objective);
      if (k.unit === "money" && k.forecast && objective.interventionGoal.basis === "incremental_revenue") {
        snapshot.goalForecast = { mean: k.forecast.value, sd: Math.max(1, (k.forecast.high - k.forecast.value) / 1.2816), target: objective.targetValue, direction: objective.direction };
        snapshot.executionProbability = this.loop(d.tenantId).pAgivenD;
      }
      const ev: Evaluation = {
        id: this.id("ev"),
        tenantId: d.tenantId,
        decisionId: d.id,
        decisionRevision: d.revision,
        status: "queued",
        inputHash: hashSnapshot(snapshot),
        snapshot,
        result: null,
        evaluatorVersion: "orion-ref-1.0.0",
        modelProvenance: { evaluator: "deterministic", model: null, promptVersion: null },
        policyVersion,
        createdAt: now,
        completedAt: null,
        expiresAt: new Date(Date.parse(now) + EVALUATION_TTL_DAYS * DAY).toISOString(),
      };
      S().evaluations.push(ev);
      d.latestEvaluationId = ev.id;
      const jobId = this.id("job");
      S().jobs.push({ id: jobId, tenantId: d.tenantId, evaluationId: ev.id, state: "queued" });
      this.audit(d.tenantId, ctx.actor.id, "evaluation.requested", `evaluation/${ev.id}`, d.revision, d.revision, ctx.correlationId, ev.inputHash.slice(0, 12));
      return ok({ evaluationId: ev.id, jobId, inputHash: ev.inputHash }, 202);
    });
    this.on("GET", "/evaluations/{id}", (ctx, p) => ok({ evaluation: this.scoped(S().evaluations, ctx, p.id) }));
    this.on("POST", "/evaluations/{id}/replay", (ctx, p) => {
      const ev = this.scoped(S().evaluations, ctx, p.id);
      const replayed = evaluate(ev.snapshot);
      const matches = hashSnapshot(ev.snapshot) === ev.inputHash && canonicalJson(replayed) === canonicalJson(ev.result);
      return ok({ matches, inputHash: ev.inputHash, evaluatorVersion: replayed.evaluatorVersion });
    });
    this.on("POST", "/decisions/{id}/choose", (ctx, p, req) => {
      this.need(ctx, "decide");
      const d = this.scoped(S().decisions, ctx, p.id);
      this.checkRevision(req, d);
      const b = asObj(req.body);
      const ev = this.latestEvaluation(d);
      if (d.state !== "Evaluated" || !ev || ev.decisionRevision !== d.revision || ev.status !== "complete") throw new ApiError(409, "invalid_transition", "Choose after a complete evaluation of this revision.");
      if (Date.parse(ev.expiresAt) < Date.parse(this.opts.now())) throw new ApiError(409, "evaluation_expired", "The evaluation expired; re-run it.");
      const choice = ev.result!.alternatives.find((a) => a.id === str(b, "alternativeId", 80));
      if (!choice || choice.isBaseline) throw bad("alternativeId must be a candidate in the evaluation");
      if (!choice.eligible) throw forbidden(`${choice.name} fails a hard policy gate: ${choice.gates.filter((g) => !g.passed).map((g) => g.detail).join("; ")}`, "policy_gate");
      d.chosenAlternativeId = choice.id;
      d.rationale = str(b, "rationale", 2000);
      d.override = choice.id !== ev.result!.recommendationId;
      if (d.override && !d.rationale.trim()) throw bad("an override needs a rationale");
      this.move(d, "AwaitingApproval", ctx.actor.id, d.override ? "override of recommendation" : undefined);
      this.audit(d.tenantId, ctx.actor.id, d.override ? "decision.override" : "decision.chosen", `decision/${d.id}`, d.revision, d.revision, ctx.correlationId, choice.name);
      return ok({ decision: d });
    });
    this.on("POST", "/decisions/{id}/approvals", (ctx, p, req) => {
      this.need(ctx, "approve");
      const d = this.scoped(S().decisions, ctx, p.id);
      this.checkRevision(req, d);
      const b = asObj(req.body);
      const policy = currentPolicy(S(), ctx.tenant.id);
      if (policy.requireIndependentApprover && d.ownerId === ctx.actor.id) throw forbidden("The decision owner cannot approve their own decision.", "not_independent");
      if (d.state !== "AwaitingApproval") throw new ApiError(409, "invalid_transition", `Nothing to approve: the decision is ${d.state}.`);
      const ev = this.scoped(S().evaluations, ctx, str(b, "evaluationId", 80));
      if (ev.id !== d.latestEvaluationId || ev.decisionRevision !== d.revision) throw new ApiError(412, "stale_evaluation", "Approve the latest evaluation of the current revision.");
      const verdict = oneOf(b, "verdict", ["approve", "reject", "request_evidence"] as const satisfies readonly ApprovalVerdict[]);
      const chosen = d.alternatives.find((a) => a.id === d.chosenAlternativeId)!;
      const financeNeeded = chosen.spendMinor > policy.financeApprovalOverMinor;
      const approval: Approval = {
        id: this.id("appr"),
        tenantId: d.tenantId,
        decisionId: d.id,
        evaluationId: ev.id,
        decisionRevision: d.revision,
        approverId: ctx.actor.id,
        role: ctx.actor.role,
        verdict,
        reason: str(b, "reason", 2000),
        policyRule: financeNeeded ? `spend over ${formatMoney(policy.financeApprovalOverMinor, currentProfile(S(), d.tenantId).currency)} needs finance` : "one executive or finance approval",
        active: verdict === "approve",
        createdAt: this.opts.now(),
      };
      S().approvals.push(approval);
      if (verdict === "reject") this.move(d, "Rejected", ctx.actor.id, approval.reason);
      if (verdict === "request_evidence") this.move(d, "NeedsEvidence", ctx.actor.id, approval.reason);
      if (verdict === "approve") {
        const active = S().approvals.filter((a) => a.decisionId === d.id && a.tenantId === d.tenantId && a.active && a.decisionRevision === d.revision);
        const satisfied = active.length > 0 && (!financeNeeded || active.some((a) => a.role === "finance"));
        if (satisfied) {
          this.move(d, "Approved", ctx.actor.id);
          // Approval and outbox write commit together.
          const actionId = `act-${d.id}-r${d.revision}`;
          const work: WorkLink = {
            id: this.id("work"),
            tenantId: d.tenantId,
            decisionId: d.id,
            actionId,
            compassProjectId: "default",
            compassTaskId: null,
            title: `${chosen.name}`,
            doneWhen: [`Delivered to the ${d.cohortSize}-account cohort`, "Completion evidence attached", "Comparison cohort held out"],
            assigneeId: S().members.find((m) => m.tenantId === d.tenantId && m.role === "operator")?.id ?? d.ownerId,
            state: "sync_pending",
            attempts: 0,
            lastError: null,
            blockedReason: null,
            createdAt: this.opts.now(),
            updatedAt: this.opts.now(),
          };
          S().work.push(work);
          S().outbox.push({ actionId, tenantId: d.tenantId, decisionId: d.id, decisionRevision: d.revision, approvalIds: active.map((a) => a.id), workId: work.id, state: "pending", attempts: 0, nextAttemptAt: this.opts.now(), lastError: null });
          this.emit("decision.approved", d.tenantId, d.id, d.revision, ctx.correlationId);
          this.emit("work.requested", d.tenantId, work.id, d.revision, actionId);
        }
      }
      this.audit(d.tenantId, ctx.actor.id, `approval.${verdict}`, `decision/${d.id}`, d.revision, d.revision, ctx.correlationId, approval.reason);
      return ok({ approval, decision: d }, 201);
    });

    // ---- work & evidence ----
    this.on("GET", "/decisions/{id}/work", (ctx, p) => {
      const d = this.scoped(S().decisions, ctx, p.id);
      return ok({ work: S().work.filter((w) => w.decisionId === d.id && w.tenantId === d.tenantId).map((w) => this.workView(w)) });
    });
    this.on("GET", "/work", (ctx) => ok({ work: S().work.filter((w) => w.tenantId === ctx.tenant.id).map((w) => this.workView(w)) }));
    this.on("POST", "/work/{id}/requeue", (ctx, p) => {
      const w = this.scoped(S().work, ctx, p.id);
      const d = this.scoped(S().decisions, ctx, w.decisionId);
      if (ctx.actor.role !== "admin" && d.ownerId !== ctx.actor.id) throw forbidden("Only an admin or the decision owner can requeue work.");
      const action = S().outbox.find((o) => o.actionId === w.actionId && o.tenantId === w.tenantId);
      if (!action || action.state !== "dead") throw new ApiError(409, "invalid_transition", "Only failed syncs can be requeued.");
      action.state = "pending";
      action.attempts = 0;
      action.nextAttemptAt = this.opts.now();
      w.state = "sync_pending";
      this.audit(w.tenantId, ctx.actor.id, "work.requeued", `work/${w.id}`, null, null, ctx.correlationId, action.actionId);
      return ok({ work: this.workView(w) });
    });
    this.on("POST", "/work/{id}/evidence", (ctx, p, req) => {
      this.need(ctx, "evidence");
      const w = this.scoped(S().work, ctx, p.id);
      if (ctx.actor.role === "operator" && w.assigneeId !== ctx.actor.id) throw forbidden("Only the assignee can submit evidence for this work.");
      if (w.state !== "linked" && w.state !== "in_review") throw new ApiError(409, "invalid_transition", `Work is ${w.state}.`);
      const b = asObj(req.body);
      const digest = str(b, "digest", 64);
      if (!/^[0-9a-f]{64}$/.test(digest)) throw bad("digest must be a SHA-256 hex string");
      const ev: Evidence = { id: this.id("evd"), tenantId: w.tenantId, workId: w.id, kind: oneOf(b, "kind", ["file", "link", "note", "metric"] as const), title: str(b, "title", 200), digest, sensitivity: oneOf(b, "sensitivity", ["public", "internal", "confidential"] as const), authorId: ctx.actor.id, capturedAt: this.opts.now(), status: "submitted", reviewNote: null };
      S().evidence.push(ev);
      w.state = "in_review";
      w.updatedAt = this.opts.now();
      const d = this.scoped(S().decisions, ctx, w.decisionId);
      if (d.state === "Executing") this.move(d, "DeliveryReview", ctx.actor.id);
      this.emit("evidence.submitted", w.tenantId, w.id, d.revision, ctx.correlationId);
      this.audit(w.tenantId, ctx.actor.id, "evidence.submitted", `work/${w.id}`, null, null, ctx.correlationId, ev.title);
      return ok({ evidence: ev }, 201);
    });
    this.on("POST", "/work/{id}/delivery-review", (ctx, p, req) => {
      this.need(ctx, "review");
      const w = this.scoped(S().work, ctx, p.id);
      const d = this.scoped(S().decisions, ctx, w.decisionId);
      if (w.state !== "in_review" || d.state !== "DeliveryReview") throw new ApiError(409, "invalid_transition", "No delivery evidence is awaiting review.");
      const b = asObj(req.body);
      const verdict = oneOf(b, "verdict", ["verify", "reject"] as const);
      const reason = str(b, "reason", 2000);
      const pending = S().evidence.filter((e) => e.workId === w.id && e.tenantId === w.tenantId && e.status === "submitted");
      if (pending.some((e) => e.authorId === ctx.actor.id)) throw forbidden("Reviewers cannot verify their own evidence.", "not_independent");
      for (const e of pending) {
        e.status = verdict === "verify" ? "accepted" : "rejected";
        e.reviewNote = reason;
      }
      if (verdict === "verify") {
        w.state = "verified";
        this.move(d, "Measuring", ctx.actor.id, reason);
        const task = this.tasks(d.tenantId).find((t) => t.workId === w.id || (t.actionId && t.actionId === w.actionId));
        if (task) Object.assign(task, { status: "done", completedAt: this.opts.now(), updatedAt: this.opts.now(), evidenceNote: reason, revision: task.revision + 1 });
        this.emit("delivery.verified", d.tenantId, w.id, d.revision, ctx.correlationId);
      } else {
        w.state = "linked";
        this.move(d, "Executing", ctx.actor.id, reason);
      }
      w.updatedAt = this.opts.now();
      this.audit(w.tenantId, ctx.actor.id, verdict === "verify" ? "delivery.verified" : "delivery.rejected", `work/${w.id}`, null, null, ctx.correlationId, reason);
      return ok({ work: this.workView(w), decision: d });
    });

    // ---- outcomes ----
    this.on("GET", "/outcomes", (ctx) => ok({ outcomes: S().outcomes.filter((o) => o.tenantId === ctx.tenant.id).map((o) => ({ ...o, decisionTitle: S().decisions.find((d) => d.id === o.decisionId)?.title ?? "" })) }));
    this.on("POST", "/decisions/{id}/outcomes", (ctx, p, req) => {
      this.need(ctx, "decide");
      const d = this.scoped(S().decisions, ctx, p.id);
      if (d.state !== "Measuring") throw new ApiError(409, "invalid_transition", "Register outcomes once delivery is verified.");
      const b = asObj(req.body);
      const method = oneOf(b, "method", ["random_holdout", "matched_cohort", "pre_post"] as const satisfies readonly ComparisonMethod[]);
      const windowStart = isoDate(b, "windowStart");
      const windowEnd = isoDate(b, "windowEnd");
      if (Date.parse(windowEnd) <= Date.parse(windowStart)) throw bad("windowEnd must follow windowStart");
      const m = measureOutcome(method, intArray(b, "treatedValues"), intArray(b, "comparisonValues"));
      const approval = S().approvals.find((a) => a.decisionId === d.id && a.tenantId === d.tenantId && a.active && a.decisionRevision === d.revision);
      const ev = this.scoped(S().evaluations, ctx, approval?.evaluationId ?? d.latestEvaluationId ?? "");
      const objective = this.scoped(S().objectives, ctx, d.objectiveId);
      const metric = this.scoped(S().metrics, ctx, objective.metricId);
      const chosen = ev.result?.alternatives.find((a) => a.id === d.chosenAlternativeId);
      const goal = ev.snapshot.goal;
      const outcome: Outcome = {
        id: this.id("out"),
        tenantId: d.tenantId,
        decisionId: d.id,
        evaluationId: ev.id,
        metricId: metric.id,
        metricVersion: metric.version,
        windowStart,
        windowEnd,
        measurement: m,
        predicted: { evContributionMinor: chosen?.evContributionMinor ?? null, evRevenueMinor: chosen?.evRevenueMinor ?? null, pGoal: chosen?.pGoal ?? null },
        goalMet: goal.direction === "increase" ? m.incrementalTotalMinor >= goal.target : m.incrementalTotalMinor <= goal.target,
        sourceRowIds: this.tenantRows(d.tenantId)
          .filter((r) => r.occurredAt >= windowStart && r.occurredAt < windowEnd)
          .slice(0, 500)
          .map((r) => r.id),
        status: "pending_review",
        reviewerId: null,
        reviewRationale: null,
        next: null,
        revisitOn: null,
        createdAt: this.opts.now(),
        reviewedAt: null,
      };
      S().outcomes.push(outcome);
      this.audit(d.tenantId, ctx.actor.id, "outcome.registered", `outcome/${outcome.id}`, d.revision, d.revision, ctx.correlationId, m.confidenceLabel);
      return ok({ outcome }, 201);
    });
    this.on("POST", "/outcomes/{id}/review", (ctx, p, req) => {
      this.need(ctx, "review");
      const o = this.scoped(S().outcomes, ctx, p.id);
      const d = this.scoped(S().decisions, ctx, o.decisionId);
      if (o.status !== "pending_review") throw new ApiError(409, "invalid_transition", `Outcome is already ${o.status}.`);
      const b = asObj(req.body);
      o.status = oneOf(b, "verdict", ["verified", "disputed"] as const);
      o.reviewRationale = str(b, "rationale", 2000);
      o.next = b.next === undefined ? null : oneOf(b, "next", ["expand", "revise", "stop"] as const);
      o.revisitOn = b.revisitOn === undefined ? null : str(b, "revisitOn", 10);
      o.reviewerId = ctx.actor.id;
      o.reviewedAt = this.opts.now();
      if (b.assetLeft !== undefined && str(b, "assetLeft", 300).trim()) {
        // Defensibility compounds when each cycle leaves something valuable and hard to copy behind.
        S().moats.push({ id: this.id("moat"), tenantId: d.tenantId, decisionId: d.id, kind: b.assetKind === undefined ? "know_how" : oneOf(b, "assetKind", MOAT_KINDS.map((k) => k.kind)), mechanism: str(b, "assetLeft", 300).trim(), ownerId: ctx.actor.id, horizonMonths: 12, stage: "created", pCreatedRetained: 0.5, conditionalValueMinor: 0, evidence: [o.reviewRationale ?? ""], realizedMinor: null });
      }
      if (o.status === "verified") {
        this.move(d, "Debriefed", ctx.actor.id, o.reviewRationale);
        if (o.predicted.pGoal !== null) S().forecasts.push({ id: this.id("fc"), tenantId: d.tenantId, decisionTitle: d.title, p: o.predicted.pGoal, outcome: o.goalMet ? 1 : 0, at: o.reviewedAt });
      }
      this.emit("outcome.reviewed", d.tenantId, o.id, d.revision, ctx.correlationId);
      this.audit(d.tenantId, ctx.actor.id, `outcome.${o.status}`, `outcome/${o.id}`, d.revision, d.revision, ctx.correlationId, o.reviewRationale);
      return ok({ outcome: o, decision: d });
    });

    // ---- moats ----
    this.on("GET", "/moats", (ctx) => ok({ moats: S().moats.filter((m) => m.tenantId === ctx.tenant.id).map((m) => ({ ...m, potentialMinor: moatPotentialMinor(m), decisionTitle: S().decisions.find((d) => d.id === m.decisionId)?.title ?? this.tasks(ctx.tenant.id).find((t) => t.id === m.taskId)?.title ?? "" })), defensibility: this.defensibility(ctx.tenant.id) }));

    // ---- Compass tasks, sources, documents ----
    this.registerTasks();
    this.registerSources();
    this.on("POST", "/moats/{id}/advance", (ctx, p, req) => {
      this.need(ctx, "decide");
      const m = this.scoped(S().moats, ctx, p.id);
      const next = advanceMoat(m.stage);
      if (!next) throw new ApiError(409, "invalid_transition", "Already realized.");
      const b = asObj(req.body);
      m.evidence.push(str(b, "evidence", 500));
      if (next === "realized") m.realizedMinor = int(b, "realizedMinor", 0);
      m.stage = next;
      this.audit(m.tenantId, ctx.actor.id, `moat.${next}`, `moat/${m.id}`, null, null, ctx.correlationId, null);
      return ok({ moat: m });
    });

    // ---- policy, profile, audit ----
    this.on("GET", "/policy", (ctx) => ok({ policy: currentPolicy(S(), ctx.tenant.id), history: S().policies.filter((x) => x.tenantId === ctx.tenant.id) }));
    this.on("POST", "/policy", (ctx, _p, req) => {
      this.need(ctx, "configure");
      const b = asObj(req.body);
      const cur = currentPolicy(S(), ctx.tenant.id);
      const evaluation = { ...cur.evaluation };
      if (b.maxLossProbability !== undefined) evaluation.maxLossProbability = num(b, "maxLossProbability", 0, 1);
      if (b.maxSpendMinor !== undefined) evaluation.maxSpendMinor = int(b, "maxSpendMinor", 0);
      if (b.maxDownsideExposureMinor !== undefined) evaluation.maxDownsideExposureMinor = int(b, "maxDownsideExposureMinor", 0);
      if (b.maxInputAgeDays !== undefined) evaluation.maxInputAgeDays = int(b, "maxInputAgeDays", 1, 3650);
      if (b.rankBy !== undefined) evaluation.rankBy = oneOf(b, "rankBy", ["p_win", "expected_profit"] as const);
      const policy = { ...cur, version: cur.version + 1, createdAt: this.opts.now(), createdBy: ctx.actor.id, evaluation, financeApprovalOverMinor: b.financeApprovalOverMinor === undefined ? cur.financeApprovalOverMinor : int(b, "financeApprovalOverMinor", 0) };
      S().policies.push(policy);
      this.audit(ctx.tenant.id, ctx.actor.id, "policy.versioned", `policy/v${policy.version}`, cur.version, policy.version, ctx.correlationId, "applies prospectively");
      return ok({ policy }, 201);
    });
    this.on("GET", "/audit", (ctx, _p, _r, q) => {
      this.need(ctx, "audit");
      const cursor = Number(q.get("cursor") ?? 0) || 0;
      const limit = Math.min(500, Number(q.get("limit") ?? 200) || 200);
      const events = S()
        .audit.filter((e) => e.tenantId === ctx.tenant.id && e.seq > cursor)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit);
      return ok({ events, nextCursor: events.length === limit ? events[events.length - 1].seq : null });
    });
    this.on("GET", "/outbox", (ctx) => ok({ outbox: S().outbox.filter((o) => o.tenantId === ctx.tenant.id) }));
  }
}
