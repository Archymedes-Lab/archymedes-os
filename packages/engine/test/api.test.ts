/* eslint-disable @typescript-eslint/no-explicit-any -- API responses are inspected structurally in tests */
import { beforeEach, describe, expect, it } from "vitest";
import { annualPlanAlternative, baselineAlternative, leadFollowUpAlternative } from "../src/fixtures";
import type { EntRequest, EntResponse } from "../src/api-types";
import { EnterpriseApi } from "../src/api";
import type { BuiltInCompass } from "../src/compass-adapter";
import { CO_A, CO_B, seedState } from "./fixture-seed";

const ASOF = "2026-11-18T09:00:00.000Z";
let clock = Date.parse("2026-11-20T08:00:00.000Z");
const now = () => new Date(clock).toISOString();

let compass: BuiltInCompass;
let api: EnterpriseApi;

beforeEach(() => {
  clock = Date.parse("2026-11-20T08:00:00.000Z");
  api = new EnterpriseApi(seedState(now()), { now });
  compass = api.compass as BuiltInCompass;
});

const ws = (w: string, path: string) => `/v1/workspaces/${w}${path}`;
async function call<T = any>(actor: string, req: EntRequest): Promise<EntResponse<T>> {
  return (await api.handle(actor, req)) as EntResponse<T>;
}
const get = <T = any>(actor: string, path: string, w: string = CO_A.ws) => call<T>(actor, { method: "GET", path: ws(w, path) });
const post = <T = any>(actor: string, path: string, body: unknown, extra: Partial<EntRequest> = {}, w: string = CO_A.ws) =>
  call<T>(actor, { method: "POST", path: ws(w, path), body, ...extra });

async function newDecision(alts = [baselineAlternative(ASOF), leadFollowUpAlternative(ASOF)]) {
  const r = await post(CO_A.lead, "/decisions", {
    objectiveId: CO_A.objective,
    title: "Lift trial conversion",
    hypothesis: "Faster follow-up converts more trials.",
    horizonDays: 90,
    cohortSize: 420,
    alternatives: alts,
  });
  expect(r.status).toBe(201);
  return r.body.decision as { id: string; revision: number };
}

async function evaluateDecision(id: string) {
  const r = await post(CO_A.lead, `/decisions/${id}/evaluations`, {});
  expect(r.status).toBe(202);
  await api.runJobs();
  const e = await get(CO_A.lead, `/evaluations/${r.body.evaluationId}`);
  expect(e.status).toBe(200);
  return e.body.evaluation;
}

async function approve(id: string, evaluationId: string, revision: number, actor: string = CO_A.exec, key = `appr-${id}-${actor}`) {
  return post(actor, `/decisions/${id}/approvals`, { evaluationId, verdict: "approve", reason: "Within risk appetite." }, { idempotencyKey: key, ifRevision: revision });
}

describe("first engineering ticket — end-to-end revenue workflow (§12)", () => {
  it("goal → Orion comparison → approval → one Compass task → evidence review → measured debrief", async () => {
    const d = await newDecision([baselineAlternative(ASOF), leadFollowUpAlternative(ASOF), annualPlanAlternative(ASOF)]);
    const evaluation = await evaluateDecision(d.id);
    expect(evaluation.status).toBe("complete");
    expect(evaluation.result.recommendationId).toBe("alt-lead-follow-up");
    expect(evaluation.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(evaluation.evaluatorVersion).toBeTruthy();

    // Submitting the choice moves it to approval.
    const choose = await post(CO_A.lead, `/decisions/${d.id}/choose`, { alternativeId: "alt-lead-follow-up", rationale: "Highest EV; moat upside." }, { ifRevision: d.revision });
    expect(choose.status).toBe(200);
    expect(choose.body.decision.state).toBe("AwaitingApproval");

    const a = await approve(d.id, evaluation.id, d.revision);
    expect(a.status).toBe(201);
    expect(a.body.decision.state).toBe("Approved");

    await api.drainOutbox();
    const work = await get(CO_A.lead, `/decisions/${d.id}/work`);
    expect(work.body.work).toHaveLength(1);
    const w = work.body.work[0];
    expect(w.compassTaskId).toMatch(/^CMP-/);
    expect(w.state).toBe("linked");
    expect((await get(CO_A.lead, `/decisions/${d.id}`)).body.decision.state).toBe("Executing");

    const ev = await post(CO_A.operator, `/work/${w.id}/evidence`, { title: "Call log export", kind: "file", digest: "a".repeat(64), sensitivity: "internal" });
    expect(ev.status).toBe(201);
    const dr = await post(CO_A.finance, `/work/${w.id}/delivery-review`, { verdict: "verify", reason: "Log matches 412 accounts." });
    expect(dr.status).toBe(200);
    expect(dr.body.decision.state).toBe("Measuring");

    const out = await post(CO_A.lead, `/decisions/${d.id}/outcomes`, {
      method: "random_holdout",
      treatedValues: [3000, 4000, 5000, 2000],
      comparisonValues: [1000, 2000, 1500, 1500],
      windowStart: "2026-11-20T00:00:00.000Z",
      windowEnd: "2027-02-18T00:00:00.000Z",
    });
    expect(out.status).toBe(201);
    expect(out.body.outcome.measurement.attribution).toBe("causal");
    expect(out.body.outcome.metricVersion).toBeGreaterThanOrEqual(1);
    expect(out.body.outcome.evaluationId).toBe(evaluation.id);

    const rev = await post(CO_A.finance, `/outcomes/${out.body.outcome.id}/review`, { verdict: "verified", rationale: "Holdout clean.", next: "expand", revisitOn: "2027-03-01" });
    expect(rev.status).toBe(200);
    expect(rev.body.decision.state).toBe("Debriefed");
  });

  it("second run: the same action is blocked at a 20% loss threshold", async () => {
    const p = await post(CO_A.admin, "/policy", { maxLossProbability: 0.2 });
    expect(p.status).toBe(201);
    expect(p.body.policy.version).toBeGreaterThan(1);
    const d = await newDecision();
    const e = await evaluateDecision(d.id);
    expect(e.result.recommendationId).toBeNull();
    const choose = await post(CO_A.lead, `/decisions/${d.id}/choose`, { alternativeId: "alt-lead-follow-up", rationale: "Try anyway" }, { ifRevision: d.revision });
    expect(choose.status).toBe(403);
    expect(choose.body.error.code).toBe("policy_gate");
  });
});

describe("acceptance checks (§11)", () => {
  it("tenants with identical external CRM IDs cannot see, mutate or infer each other's records", async () => {
    const objB = (await get(CO_B.admin, "/objectives", CO_B.ws)).body.objectives[0];
    // Company A actor addressing Company B's workspace: indistinguishable from nonexistent.
    expect((await get(CO_A.admin, "/objectives", CO_B.ws)).status).toBe(404);
    expect((await get(CO_A.admin, "/today", "ws-does-not-exist")).status).toBe(404);
    // Company A actor referencing Company B's objective id inside Company A's workspace.
    const r = await post(CO_A.lead, "/decisions", { objectiveId: objB.id, title: "x", hypothesis: "", horizonDays: 90, cohortSize: 1, alternatives: [baselineAlternative(ASOF), leadFollowUpAlternative(ASOF)] });
    expect(r.status).toBe(404);
    // Both tenants hold INV-0001; importing it into Company A dedupes only against Company A.
    const rowsA = (await get(CO_A.admin, "/source-rows")).body.total;
    const imp = await post(CO_A.admin, "/imports", { csv: "invoice_id,date,amount\nINV-NEW-1,2026-11-19,10.00", mapping: { externalId: "invoice_id", occurredAt: "date", amount: "amount", defaultCurrency: "USD", extra: {} }, dryRun: false });
    expect(imp.status).toBe(201);
    expect((await get(CO_A.admin, "/source-rows")).body.total).toBe(rowsA + 1);
    expect((await get(CO_B.admin, "/source-rows", CO_B.ws)).body.rows.some((x: { externalId: string }) => x.externalId === "INV-NEW-1")).toBe(false);
    const dup = await post(CO_B.admin, "/imports", { csv: "invoice_id,date,amount\nINV-0001,2026-11-19,10.00", mapping: { externalId: "invoice_id", occurredAt: "date", amount: "amount", defaultCurrency: "EUR", extra: {} }, dryRun: true }, {}, CO_B.ws);
    expect(dup.body.preview.duplicates).toHaveLength(1); // its own INV-0001, not Company A's
  });

  it("a replayed import preserves one business effect", async () => {
    const body = { csv: "invoice_id,date,amount\nINV-R-1,2026-11-19,99.00", mapping: { externalId: "invoice_id", occurredAt: "date", amount: "amount", defaultCurrency: "USD", extra: {} }, dryRun: false };
    const before = (await get(CO_A.admin, "/source-rows")).body.total;
    await post(CO_A.admin, "/imports", body);
    const again = await post(CO_A.admin, "/imports", body);
    expect(again.status).toBe(201);
    expect(again.body.imported).toBe(0);
    expect((await get(CO_A.admin, "/source-rows")).body.total).toBe(before + 1);
  });

  it("an import in a different currency than the company is rejected per row", async () => {
    const r = await post(CO_A.admin, "/imports", { csv: "invoice_id,date,amount,currency\nINV-X,2026-11-19,5,EUR", mapping: { externalId: "invoice_id", occurredAt: "date", amount: "amount", currency: "currency", defaultCurrency: "USD", extra: {} }, dryRun: true });
    expect(r.body.preview.invalid[0].reason).toMatch(/currency/i);
  });

  it("a repeated approval request is idempotent; a conflicting reuse of the key is 409", async () => {
    const d = await newDecision();
    const e = await evaluateDecision(d.id);
    await post(CO_A.lead, `/decisions/${d.id}/choose`, { alternativeId: "alt-lead-follow-up", rationale: "ok" }, { ifRevision: d.revision });
    const first = await approve(d.id, e.id, d.revision, CO_A.exec, "k1");
    const replay = await approve(d.id, e.id, d.revision, CO_A.exec, "k1");
    expect(replay).toEqual(first);
    const conflict = await post(CO_A.exec, `/decisions/${d.id}/approvals`, { evaluationId: e.id, verdict: "reject", reason: "changed my mind" }, { idempotencyKey: "k1", ifRevision: d.revision });
    expect(conflict.status).toBe(409);
    await api.drainOutbox();
    await api.drainOutbox();
    expect(compass.taskCount(CO_A.ws)).toBe(1);
  });

  it("a Compass timeout after the write reconciles by action ID: one task", async () => {
    const d = await newDecision();
    const e = await evaluateDecision(d.id);
    await post(CO_A.lead, `/decisions/${d.id}/choose`, { alternativeId: "alt-lead-follow-up", rationale: "ok" }, { ifRevision: d.revision });
    compass.failNext("timeout_after_write");
    await approve(d.id, e.id, d.revision);
    await api.drainOutbox();
    let work = (await get(CO_A.lead, `/decisions/${d.id}/work`)).body.work;
    expect(work[0].state).toBe("sync_pending");
    clock += 60_000;
    await api.drainOutbox();
    work = (await get(CO_A.lead, `/decisions/${d.id}/work`)).body.work;
    expect(work[0].state).toBe("linked");
    expect(compass.taskCount(CO_A.ws)).toBe(1);
  });

  it("a stale approval cannot dispatch work after the revision changes", async () => {
    const d = await newDecision();
    const e = await evaluateDecision(d.id);
    await post(CO_A.lead, `/decisions/${d.id}/choose`, { alternativeId: "alt-lead-follow-up", rationale: "ok" }, { ifRevision: d.revision });
    await approve(d.id, e.id, d.revision);
    const alts = [baselineAlternative(ASOF), { ...leadFollowUpAlternative(ASOF), spendMinor: 400_000 }];
    const edit = await call(CO_A.lead, { method: "PATCH", path: ws(CO_A.ws, `/decisions/${d.id}`), body: { alternatives: alts }, ifRevision: d.revision });
    expect(edit.status).toBe(200);
    expect(edit.body.decision.revision).toBe(d.revision + 1);
    expect(edit.body.decision.state).toBe("Draft");
    await api.drainOutbox();
    expect(compass.taskCount(CO_A.ws)).toBe(0);
    const approvals = (await get(CO_A.lead, `/decisions/${d.id}`)).body.approvals;
    expect(approvals.every((a: { active: boolean }) => !a.active)).toBe(true);
    // Approving with the old revision is a stale precondition.
    expect((await approve(d.id, e.id, d.revision, CO_A.exec, "late")).status).toBe(412);
  });

  it("an operator can submit evidence, a reviewer can reject it, and both are audited", async () => {
    const work = (await get(CO_A.operator, "/work")).body.work.find((w: { state: string }) => w.state === "linked");
    expect(work).toBeTruthy();
    const ev = await post(CO_A.operator, `/work/${work.id}/evidence`, { title: "Screenshot", kind: "link", digest: "b".repeat(64), sensitivity: "internal" });
    expect(ev.status).toBe(201);
    const rej = await post(CO_A.finance, `/work/${work.id}/delivery-review`, { verdict: "reject", reason: "Missing the 30 SMB accounts." });
    expect(rej.status).toBe(200);
    expect(rej.body.decision.state).toBe("Executing");
    const audit = (await get(CO_A.auditor, "/audit")).body.events.map((e: { action: string }) => e.action);
    expect(audit).toContain("evidence.submitted");
    expect(audit).toContain("delivery.rejected");
  });

  it("an actor outside the authorized lane cannot approve, dispatch or review", async () => {
    const d = await newDecision();
    const e = await evaluateDecision(d.id);
    await post(CO_A.lead, `/decisions/${d.id}/choose`, { alternativeId: "alt-lead-follow-up", rationale: "ok" }, { ifRevision: d.revision });
    expect((await approve(d.id, e.id, d.revision, CO_A.operator)).status).toBe(403);
    expect((await approve(d.id, e.id, d.revision, CO_A.lead)).status).toBe(403); // no self-approval
    expect((await post(CO_A.operator, "/policy", { maxLossProbability: 0.9 })).status).toBe(403);
    expect((await post(CO_A.auditor, "/decisions", {})).status).toBe(403);
  });

  it("outcomes trace to source rows and the exact metric version; rankings replay from the snapshot", async () => {
    const outcomes = (await get(CO_A.finance, "/outcomes")).body.outcomes;
    const o = outcomes[0];
    expect(o.metricVersion).toBeGreaterThanOrEqual(1);
    expect(o.sourceRowIds.length).toBeGreaterThan(0);
    const replay = await post(CO_A.finance, `/evaluations/${o.evaluationId}/replay`, {});
    expect(replay.status).toBe(200);
    expect(replay.body.matches).toBe(true);
  });

  it("invalid payloads are 400 and unknown routes 404", async () => {
    expect((await post(CO_A.lead, "/decisions", { objectiveId: 5 })).status).toBe(400);
    expect((await get(CO_A.lead, "/nope")).status).toBe(404);
    expect((await get("u-nobody", "/today")).status).toBe(404);
  });

  it("an objective without owner, source, baseline period and target date cannot influence rankings", async () => {
    const r = await post(CO_A.admin, "/objectives", { name: "Gross margin", metricId: CO_A.metric, direction: "increase", targetValue: 1 });
    expect(r.status).toBe(201);
    expect(r.body.objective.status).toBe("draft");
    expect(r.body.objective.missing).toEqual(expect.arrayContaining(["owner", "baselinePeriod", "deadline"]));
    const d = await post(CO_A.lead, "/decisions", { objectiveId: r.body.objective.id, title: "x", hypothesis: "", horizonDays: 90, cohortSize: 1, alternatives: [baselineAlternative(ASOF), leadFollowUpAlternative(ASOF)] });
    expect(d.status).toBe(201);
    const ev = await post(CO_A.lead, `/decisions/${d.body.decision.id}/evaluations`, {});
    expect(ev.status).toBe(403);
    expect(ev.body.error.code).toBe("objective_inactive");
  });

  it("Today shows KPIs with freshness, decisions needing attention, owned work and outcome changes", async () => {
    const t = (await get(CO_A.exec, "/today")).body;
    expect(t.kpis[0]).toEqual(expect.objectContaining({ baseline: expect.any(Object), target: expect.any(Object), freshness: expect.any(Object) }));
    expect(t.kpis[0].series.length).toBeGreaterThan(8);
    expect(Array.isArray(t.attention)).toBe(true);
    expect(t.attention.some((a: { state: string }) => a.state === "AwaitingApproval")).toBe(true);
    expect(Array.isArray(t.work)).toBe(true);
    expect(Array.isArray(t.outcomes)).toBe(true);
    expect(t.calibration).toEqual(expect.objectContaining({ n: expect.any(Number) }));
  });

  it("state survives a save/load round trip", async () => {
    const d = await newDecision();
    const restored = new EnterpriseApi(JSON.parse(JSON.stringify(api.snapshot())), { now });
    expect((await restored.handle(CO_A.lead, { method: "GET", path: ws(CO_A.ws, `/decisions/${d.id}`) })).status).toBe(200);
  });
});

describe("company-agnostic configuration", () => {
  it("an admin adds team members; others cannot", async () => {
    const body = { name: "Riley Park", title: "Account executive", role: "operator", department: "Sales" };
    expect((await post(CO_A.lead, "/members", body)).status).toBe(403);
    const r = await post(CO_A.admin, "/members", body);
    expect(r.status).toBe(201);
    expect((await get(CO_A.admin, "/members")).body.members.some((m: { name: string }) => m.name === "Riley Park")).toBe(true);
    expect((await get(r.body.member.id, "/today")).status).toBe(200);
    expect((await post(CO_A.admin, "/members", { ...body, role: "owner" })).status).toBe(400);
  });

  it("profile edits create a new version and keep the currency fixed", async () => {
    const r = await post(CO_A.admin, "/profile", { name: "Renamed Co", timezone: "Europe/Paris", fiscalYearStartMonth: 7, grossMarginBps: 5500 });
    expect(r.status).toBe(201);
    expect(r.body.profile).toEqual(expect.objectContaining({ version: 2, name: "Renamed Co", timezone: "Europe/Paris", fiscalYearStartMonth: 7, grossMarginBps: 5500, currency: "USD" }));
    expect((await get(CO_A.admin, "/me")).body.tenant.name).toBe("Renamed Co");
    expect((await post(CO_A.admin, "/profile", { timezone: "Nowhere/Zone" })).status).toBe(400);
    expect((await post(CO_A.lead, "/profile", { name: "x" })).status).toBe(403);
  });

  it("a draft goal becomes active once target, deadline, owner and a data baseline are set", async () => {
    const created = (await post(CO_A.admin, "/objectives", { name: "Revenue per week", metricId: CO_A.metric, direction: "increase", targetValue: 0 })).body.objective;
    expect(created.status).toBe("draft");
    const r = await post(CO_A.admin, `/objectives/${created.id}`, { targetValue: 100_000_00, deadline: "2027-03-31", ownerId: CO_A.lead, baselineFromData: { weeks: 13 } });
    expect(r.status).toBe(200);
    expect(r.body.objective.status).toBe("active");
    expect(r.body.objective.missing).toEqual([]);
    expect(r.body.objective.baseline.value).toBeGreaterThan(0);
    expect(r.body.objective.version).toBe(2);
  });

  it("the first committed import maps billing metrics that had no source, as a new metric version", async () => {
    const m = (await post(CO_A.admin, "/metrics", { name: "Billed amount", unit: "money", calc: { kind: "sum", field: "amount", filters: [] }, grain: "week", mapsFrom: "billing" })).body.metric;
    expect(m.source).toBe("not mapped");
    await post(CO_A.admin, "/imports", { csv: "invoice_id,date,amount\nINV-M-1,2026-11-19,10.00", mapping: { externalId: "invoice_id", occurredAt: "date", amount: "amount", defaultCurrency: "USD", extra: {} }, dryRun: false, source: "ledger.csv" });
    const after = (await get(CO_A.admin, "/metrics")).body.metrics.find((x: { id: string }) => x.id === m.id);
    expect(after.source).toBe("ledger.csv");
    expect(after.version).toBe(m.version + 1);
  });
});

describe("Compass inside: task management", () => {
  const T = (actor: string, p: string, body: unknown, extra = {}) => post(actor, p, body, extra);
  it("anyone on the team can add a task; it is ranked with reasons; auditors cannot", async () => {
    expect((await T(CO_A.auditor, "/tasks", { title: "x" })).status).toBe(403);
    const r = await T(CO_A.lead, "/tasks", { title: "Ship partner integration", ownerId: CO_A.operator, impact: 5, confidence: 0.7, effortDays: 3, doneWhen: ["Partner live"], goalId: CO_A.objective, moat: { kind: "integration", note: "Deep API link", strength: 4 } });
    expect(r.status).toBe(201);
    expect(r.body.task.key).toMatch(/^CMP-\d{4}$/);
    const list = (await get(CO_A.lead, "/tasks")).body.tasks;
    const mine = list.find((t: { id: string }) => t.id === r.body.task.id);
    expect(mine.reasons).toEqual(expect.arrayContaining(["High impact", "Builds a lasting advantage"]));
    expect(mine.ownerName).toBe("Operator A");
  });

  it("blockers pause a task and resolving them resumes it", async () => {
    const t = (await T(CO_A.lead, "/tasks", { title: "Price page", ownerId: CO_A.operator })).body.task;
    const b = await T(CO_A.operator, `/tasks/${t.id}/blockers`, { text: "Waiting on copy" });
    expect(b.body.task.status).toBe("blocked");
    const r = await T(CO_A.operator, `/tasks/${t.id}/blockers/${b.body.task.blockers[0].id}/resolve`, {});
    expect(r.body.task.status).toBe("doing");
  });

  it("done needs proof of delivery; the debrief compares predicted with actual and can leave an advantage behind", async () => {
    const t = (await T(CO_A.lead, "/tasks", { title: "Referral flow", ownerId: CO_A.operator, impact: 4 })).body.task;
    expect((await T(CO_A.operator, `/tasks/${t.id}/done`, {})).status).toBe(400);
    const d = await T(CO_A.operator, `/tasks/${t.id}/done`, { evidenceNote: "Live since Tuesday, 14 referrals" });
    expect(d.body.task.status).toBe("done");
    const deb = await T(CO_A.operator, `/tasks/${t.id}/debrief`, { actualImpact: 3, lesson: "Referrals need a reminder", assetLeft: "Referral playbook", assetKind: "process" });
    expect(deb.status).toBe(200);
    expect(deb.body.task.debrief.actualImpact).toBe(3);
    const moats = (await get(CO_A.lead, "/moats")).body.moats;
    expect(moats.some((m: { mechanism: string; kind: string }) => m.mechanism === "Referral playbook" && m.kind === "process")).toBe(true);
  });

  it("operators can only change their own or unassigned tasks", async () => {
    const t = (await T(CO_A.lead, "/tasks", { title: "Exec-only", ownerId: CO_A.finance })).body.task;
    expect((await T(CO_A.operator, `/tasks/${t.id}`, { status: "doing" })).status).toBe(403);
  });

  it("approved decisions become Compass tasks, which complete when delivery is verified", async () => {
    const d = await newDecision();
    const e = await evaluateDecision(d.id);
    await post(CO_A.lead, `/decisions/${d.id}/choose`, { alternativeId: "alt-lead-follow-up", rationale: "ok" }, { ifRevision: d.revision });
    await approve(d.id, e.id, d.revision);
    await api.drainOutbox();
    const task = (await get(CO_A.lead, "/tasks")).body.tasks.find((t: { decisionId: string }) => t.decisionId === d.id);
    expect(task.status).toBe("doing");
    expect((await post(CO_A.operator, `/tasks/${task.id}/done`, { evidenceNote: "x" })).status).toBe(409);
  });
});

describe("Winning on Today", () => {
  it("shows loop strength P(D)·P(A|D)·P(L|D,A), goal P(Win), getting started and defensibility", async () => {
    const t = (await get(CO_A.exec, "/today")).body;
    const l = t.winning.loop;
    expect(l.product).toBeCloseTo(l.pD * l.pAgivenD * l.pLgivenDA, 12);
    expect(["decisions", "execution", "learning"]).toContain(l.weakest);
    const g = t.winning.goals.find((x: { objectiveId: string }) => x.objectiveId === CO_A.objective);
    expect(g.pWin).toBeGreaterThan(0);
    expect(g.pWin).toBeLessThan(1);
    expect(t.gettingStarted.length).toBeGreaterThanOrEqual(6);
    expect(t.gettingStarted.find((s: { key: string }) => s.key === "data").done).toBe(true);
    expect(t.defensibility.decisionDataPairs).toBeGreaterThan(0);
    expect(Array.isArray(t.defensibility.cycles)).toBe(true);
  });

  it("evaluations carry the goal forecast so Orion ranks by P(Win | π, E)", async () => {
    const d = await newDecision();
    const e = await evaluateDecision(d.id);
    expect(e.snapshot.goalForecast).toEqual(expect.objectContaining({ target: expect.any(Number), sd: expect.any(Number) }));
    expect(e.result.rankedBy).toBe("p_win");
    expect(e.result.alternatives.every((a: { pWin: number | null }) => a.pWin !== null)).toBe(true);
  });

  it("an outcome review records what the cycle left behind", async () => {
    const o = (await get(CO_A.finance, "/outcomes")).body.outcomes.find((x: { status: string }) => x.status === "pending_review");
    const r = await post(CO_A.finance, `/outcomes/${o.id}/review`, { verdict: "verified", rationale: "ok", next: "expand", assetLeft: "Payday retry dataset", assetKind: "decision_data" });
    expect(r.status).toBe(200);
    expect((await get(CO_A.lead, "/moats")).body.moats.some((m: { mechanism: string }) => m.mechanism === "Payday retry dataset")).toBe(true);
  });
});

describe("decision rules", () => {
  it("a company can rank by expected profit instead of chance of winning", async () => {
    expect((await post(CO_A.admin, "/policy", { rankBy: "nonsense" })).status).toBe(400);
    const p = await post(CO_A.admin, "/policy", { rankBy: "expected_profit" });
    expect(p.body.policy.evaluation.rankBy).toBe("expected_profit");
    const d = await newDecision();
    const e = await evaluateDecision(d.id);
    expect(e.result.rankedBy).toBe("expected_profit");
  });
});
