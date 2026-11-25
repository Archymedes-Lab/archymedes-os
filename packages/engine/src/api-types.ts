import type { Freshness } from "./metrics";
import type { LoopStrength } from "./winning";
import type {
  AlternativeInput,
  ComparisonMethod,
  DecisionSnapshot,
  DecisionState,
  EvaluationPolicy,
  EvaluationResult,
  GoalSpec,
  ImportMapping,
  Iso,
  MetricCalc,
  MetricUnit,
  MoatStage,
  OutcomeMeasurement,
  SourceRow,
} from "./types";

/**
 * The Enterprise API contract (spec §8). The desktop calls it over IPC today;
 * the same request/response shapes serve an HTTP deployment later.
 */
export type EntMethod = "GET" | "POST" | "PATCH";

export interface EntRequest {
  method: EntMethod;
  /** /v1/workspaces/{workspaceId}/… with an optional ?query. */
  path: string;
  body?: unknown;
  idempotencyKey?: string;
  /** Revision precondition: a stale one is 412. */
  ifRevision?: number;
}

export interface EntError {
  code: string;
  message: string;
  details?: Record<string, string | number>;
}

export interface EntResponse<T = unknown> {
  status: number;
  body: T;
}

// ---------------------------------------------------------------------------
// Records (all tenant-scoped)
// ---------------------------------------------------------------------------

export type Role = "admin" | "executive" | "lead" | "operator" | "finance" | "auditor";

export interface Tenant {
  id: string;
  name: string;
  workspaceId: string;
  /** The Compass workspace this tenant maps to; null = isolated local work store. */
  compassWorkspace: string | null;
}

export interface Member {
  id: string;
  tenantId: string;
  name: string;
  title: string;
  role: Role;
  department: string;
}

export type BusinessModel = "subscription" | "services" | "commerce";

export interface BusinessProfile {
  tenantId: string;
  version: number;
  name: string;
  businessModel: BusinessModel;
  currency: string;
  timezone: string;
  fiscalYearStartMonth: number;
  grossMarginBps: number | null;
  departments: string[];
  /** Which data may reach AI services. */
  aiDataPolicy: "none" | "aggregates_only" | "redacted_records";
  createdAt: Iso;
}

export interface PolicyVersion {
  tenantId: string;
  version: number;
  createdAt: Iso;
  createdBy: string;
  evaluation: EvaluationPolicy;
  /** Above this spend a finance approval is also required. */
  financeApprovalOverMinor: number;
  /** The decision owner may not approve their own decision. */
  requireIndependentApprover: boolean;
}

export interface MetricDefinition {
  id: string;
  tenantId: string;
  version: number;
  name: string;
  description: string;
  unit: MetricUnit;
  calc: MetricCalc;
  grain: "week" | "month";
  ownerId: string;
  source: string;
  freshnessHours: number;
  /** Mapped automatically by the first committed import of this kind. */
  mapsFrom?: "billing";
}

export interface Objective {
  id: string;
  tenantId: string;
  version: number;
  name: string;
  metricId: string;
  direction: "increase" | "decrease";
  baseline: { value: number; periodStart: Iso; periodEnd: Iso } | null;
  targetValue: number;
  deadline: Iso | null;
  ownerId: string | null;
  guardrails: string[];
  leadingIndicators: string[];
  interventionGoal: GoalSpec;
  status: "draft" | "active";
  missing: string[];
  createdAt: Iso;
}

export interface StateChange {
  state: DecisionState;
  at: Iso;
  actorId: string;
  revision: number;
  note?: string;
}

export interface Decision {
  id: string;
  tenantId: string;
  objectiveId: string;
  title: string;
  hypothesis: string;
  ownerId: string;
  state: DecisionState;
  revision: number;
  alternatives: AlternativeInput[];
  horizonDays: number;
  cohortSize: number;
  chosenAlternativeId: string | null;
  rationale: string | null;
  override: boolean;
  latestEvaluationId: string | null;
  cancelledReason: string | null;
  history: StateChange[];
  createdAt: Iso;
  updatedAt: Iso;
}

export interface Evaluation {
  id: string;
  tenantId: string;
  decisionId: string;
  decisionRevision: number;
  status: "queued" | "complete" | "needs_evidence" | "failed";
  inputHash: string;
  snapshot: DecisionSnapshot;
  result: EvaluationResult | null;
  evaluatorVersion: string;
  modelProvenance: { evaluator: "deterministic"; model: null; promptVersion: null };
  policyVersion: number;
  createdAt: Iso;
  completedAt: Iso | null;
  expiresAt: Iso;
}

export type ApprovalVerdict = "approve" | "reject" | "request_evidence";

export interface Approval {
  id: string;
  tenantId: string;
  decisionId: string;
  evaluationId: string;
  decisionRevision: number;
  approverId: string;
  role: Role;
  verdict: ApprovalVerdict;
  reason: string;
  policyRule: string;
  active: boolean;
  createdAt: Iso;
}

export type WorkState = "sync_pending" | "sync_failed" | "linked" | "in_review" | "verified" | "cancelled";

export interface WorkLink {
  id: string;
  tenantId: string;
  decisionId: string;
  actionId: string;
  compassProjectId: string;
  compassTaskId: string | null;
  title: string;
  doneWhen: string[];
  assigneeId: string;
  state: WorkState;
  attempts: number;
  lastError: string | null;
  blockedReason: string | null;
  createdAt: Iso;
  updatedAt: Iso;
}

export interface Evidence {
  id: string;
  tenantId: string;
  workId: string;
  kind: "file" | "link" | "note" | "metric";
  title: string;
  digest: string;
  sensitivity: "public" | "internal" | "confidential";
  authorId: string;
  capturedAt: Iso;
  status: "submitted" | "accepted" | "rejected";
  reviewNote: string | null;
}

export interface Outcome {
  id: string;
  tenantId: string;
  decisionId: string;
  evaluationId: string;
  metricId: string;
  metricVersion: number;
  windowStart: Iso;
  windowEnd: Iso;
  measurement: OutcomeMeasurement;
  predicted: { evContributionMinor: number | null; evRevenueMinor: number | null; pGoal: number | null };
  goalMet: boolean;
  sourceRowIds: string[];
  status: "pending_review" | "verified" | "disputed";
  reviewerId: string | null;
  reviewRationale: string | null;
  next: "expand" | "revise" | "stop" | null;
  revisitOn: string | null;
  createdAt: Iso;
  reviewedAt: Iso | null;
}

/** What kind of hard-to-copy asset a cycle leaves behind. */
export type MoatKind = "customer_trust" | "integration" | "decision_data" | "process" | "proprietary_data" | "network" | "brand" | "switching_cost" | "know_how";

export const MOAT_KINDS: { kind: MoatKind; label: string }[] = [
  { kind: "customer_trust", label: "Customer trust" },
  { kind: "integration", label: "Deeper integration" },
  { kind: "decision_data", label: "Better decision data" },
  { kind: "process", label: "Repeatable process" },
  { kind: "proprietary_data", label: "Proprietary data" },
  { kind: "network", label: "Network effect" },
  { kind: "switching_cost", label: "Switching cost" },
  { kind: "brand", label: "Brand" },
  { kind: "know_how", label: "Know-how" },
];

export type TaskStatus = "todo" | "doing" | "blocked" | "done";

/** A Compass task: owner, done-when criteria, blockers, proof of delivery and a debrief. */
export interface Task {
  id: string;
  /** Human-readable Compass key, e.g. CMP-0042. */
  key: string;
  tenantId: string;
  title: string;
  description: string;
  status: TaskStatus;
  ownerId: string | null;
  createdBy: string;
  doneWhen: string[];
  dueAt: Iso | null;
  goalId: string | null;
  decisionId: string | null;
  workId: string | null;
  actionId: string | null;
  /** Expected impact on the goal, 1 (small) to 5 (large). */
  impact: number;
  /** Confidence in that impact, 0–1. */
  confidence: number;
  effortDays: number;
  moat: { kind: MoatKind; note: string; strength: number } | null;
  blockers: { id: string; text: string; createdAt: Iso; resolvedAt: Iso | null }[];
  createdAt: Iso;
  updatedAt: Iso;
  startedAt: Iso | null;
  completedAt: Iso | null;
  evidenceNote: string | null;
  debrief: { actualImpact: number; lesson: string; assetLeft: string | null; at: Iso; by: string } | null;
  revision: number;
}

export interface MoatAsset {
  id: string;
  tenantId: string;
  decisionId: string;
  taskId?: string;
  kind?: MoatKind;
  mechanism: string;
  ownerId: string;
  horizonMonths: number;
  stage: MoatStage;
  pCreatedRetained: number;
  conditionalValueMinor: number;
  evidence: string[];
  realizedMinor: number | null;
}

export interface AuditEvent {
  id: string;
  tenantId: string;
  seq: number;
  actorId: string;
  action: string;
  resource: string;
  beforeRevision: number | null;
  afterRevision: number | null;
  correlationId: string;
  at: Iso;
  detail: string | null;
}

export interface DomainEvent {
  eventId: string;
  type: string;
  tenantId: string;
  timestamp: Iso;
  aggregateId: string;
  aggregateVersion: number;
  schemaVersion: 1;
  correlationId: string;
}

export interface OutboxAction {
  actionId: string;
  tenantId: string;
  decisionId: string;
  decisionRevision: number;
  approvalIds: string[];
  workId: string;
  state: "pending" | "done" | "dead" | "cancelled_stale";
  attempts: number;
  nextAttemptAt: Iso;
  lastError: string | null;
}

export interface StoredRow extends SourceRow {
  id: string;
  tenantId: string;
  importId: string;
}

export interface ImportRecord {
  id: string;
  tenantId: string;
  actorId: string;
  source: string;
  createdAt: Iso;
  imported: number;
  duplicates: number;
  invalid: number;
  missing: number;
}

export type SourceKind = "upload" | "csv_url" | "stripe";

export interface Source {
  id: string;
  tenantId: string;
  kind: SourceKind;
  name: string;
  /** https URL for csv_url sources. */
  url: string | null;
  mapping: ImportMapping | null;
  createdAt: Iso;
  createdBy: string;
  lastSyncAt: Iso | null;
  lastResult: { imported: number; duplicates: number; invalid: number; missing: number } | null;
  lastError: string | null;
  /** A connector credential is held server-side (never returned). */
  hasSecret: boolean;
}

export type AttachKind = "goal" | "decision" | "task";

export interface DocumentRecord {
  id: string;
  tenantId: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  /** First characters of text documents, for search and context. */
  preview: string;
  /** Where the bytes live: the browser (trial) or cloud storage. */
  storage: "browser" | "cloud";
  attachedTo: { kind: AttachKind; id: string } | null;
  uploadedBy: string;
  uploadedAt: Iso;
}

export interface ForecastRecord {
  id: string;
  tenantId: string;
  decisionTitle: string;
  p: number;
  outcome: 0 | 1;
  at: Iso;
}

export interface CompassTask {
  id: string;
  workspace: string;
  projectId: string;
  actionId: string;
  title: string;
  doneWhen: string[];
  assignee: string;
  status: "todo" | "doing" | "done";
  createdAt: Iso;
}

export interface EnterpriseState {
  schemaVersion: 1;
  seq: number;
  tenants: Tenant[];
  members: Member[];
  profiles: BusinessProfile[];
  policies: PolicyVersion[];
  metrics: MetricDefinition[];
  objectives: Objective[];
  decisions: Decision[];
  evaluations: Evaluation[];
  approvals: Approval[];
  work: WorkLink[];
  evidence: Evidence[];
  outcomes: Outcome[];
  moats: MoatAsset[];
  /** Compass tasks. Optional so stores saved before Compass moved inside still load. */
  tasks?: Task[];
  sources?: Source[];
  documents?: DocumentRecord[];
  audit: AuditEvent[];
  events: DomainEvent[];
  outbox: OutboxAction[];
  rows: StoredRow[];
  imports: ImportRecord[];
  forecasts: ForecastRecord[];
  idempotency: { scope: string; bodyHash: string; response: EntResponse }[];
  jobs: { id: string; tenantId: string; evaluationId: string; state: "queued" | "done" }[];
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface SeriesPoint {
  t: Iso;
  value: number;
}

export interface KpiCard {
  objectiveId: string;
  name: string;
  metricName: string;
  unit: MetricUnit;
  currency: string;
  status: Objective["status"];
  direction: Objective["direction"];
  baseline: { value: number; label: string } | null;
  target: { value: number; deadline: Iso | null };
  actual: number | null;
  /** Projected value for the period ending at the deadline, with its 80% band and P(hit). */
  forecast: { value: number; low: number; high: number; pHit: number } | null;
  freshness: Freshness;
  source: string;
  ownerName: string | null;
  series: SeriesPoint[];
  projection: SeriesPoint[];
  definition: string;
  metricVersion: number;
}

export interface DecisionSummary {
  id: string;
  title: string;
  state: DecisionState;
  revision: number;
  ownerName: string;
  objectiveName: string;
  recommendedName: string | null;
  evContributionMinor: number | null;
  pGoal: number | null;
  closeCall: boolean;
  why: string;
  updatedAt: Iso;
}

export interface WorkView extends WorkLink {
  decisionTitle: string;
  assigneeName: string;
  evidence: Evidence[];
}

export interface TodayView {
  me: Member;
  tenant: Tenant;
  profile: BusinessProfile;
  kpis: KpiCard[];
  attention: DecisionSummary[];
  work: WorkView[];
  outcomes: (Outcome & { decisionTitle: string })[];
  blockers: string[];
  calibration: { n: number; score: number | null; baseline: number | null; skill: number | null; points: ForecastRecord[] };
  moat: { proposedMinor: number; verifiedMinor: number; realizedMinor: number; assets: number };
  winning: {
    loop: LoopStrength;
    goals: { objectiveId: string; name: string; pWin: number | null; pWinTrendOnly: number | null; initiatives: number; unit: MetricUnit }[];
  };
  gettingStarted: { key: string; label: string; hint: string; done: boolean }[];
  defensibility: Defensibility;
  tasks: TaskView[];
}

export interface Defensibility {
  assets: number;
  byKind: Record<string, number>;
  /** Forecast/outcome pairs collected: the decision data only this company has. */
  decisionDataPairs: number;
  cycles: { cycle: number; at: Iso; title: string; assetsLeft: string[]; cumulativeAssets: number; cumulativeValueMinor: number }[];
  taskCalibration: { n: number; meanAbsError: number | null; bias: number | null };
}

export interface TaskView extends Task {
  score: number | null;
  reasons: string[];
  ownerName: string | null;
  goalName: string | null;
  decisionTitle: string | null;
}

export interface DecisionDetail {
  decision: Decision;
  objective: Objective;
  evaluations: Evaluation[];
  approvals: Approval[];
  work: WorkView[];
  outcomes: Outcome[];
  moats: MoatAsset[];
  policy: PolicyVersion;
  canApprove: boolean;
  canEdit: boolean;
}

export interface SessionInfo {
  actorId: string | null;
  identities: { id: string; name: string; title: string; role: Role; workspaceId: string; tenantName: string }[];
}

export interface OutcomeRequestBody {
  method: ComparisonMethod;
  treatedValues: number[];
  comparisonValues: number[];
  windowStart: Iso;
  windowEnd: Iso;
}
