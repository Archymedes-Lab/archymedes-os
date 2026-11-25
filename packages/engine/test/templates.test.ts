import { describe, expect, it } from "vitest";
import { evaluate } from "../src/evaluator";
import { BUSINESS_TEMPLATES, buildWorkspace, exampleAlternatives, objectiveReadiness, validateWorkspaceInput } from "../src/templates";
import type { WorkspaceInput } from "../src/templates";

const NOW = "2026-11-20T08:00:00.000Z";
let n = 0;
const ids = (p: string) => `${p}-${++n}`;
const input = (over: Partial<WorkspaceInput> = {}): WorkspaceInput => ({
  companyName: "Acme",
  businessModel: "subscription",
  currency: "EUR",
  timezone: "Europe/Lisbon",
  fiscalYearStartMonth: 4,
  admin: { name: "Sam Rivera", title: "Operations lead" },
  sampleData: false,
  ...over,
});

describe("business templates (spec §4)", () => {
  it("cover the three business models with an objective, leading signals and guardrails", () => {
    expect(BUSINESS_TEMPLATES.map((t) => t.model).sort()).toEqual(["commerce", "services", "subscription"]);
    for (const t of BUSINESS_TEMPLATES) {
      expect(t.objectiveName).toBeTruthy();
      expect(t.leadingIndicators.length).toBeGreaterThan(1);
      expect(t.guardrails.length).toBeGreaterThan(1);
      expect(t.metrics.length).toBeGreaterThan(0);
      expect(t.examples.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("every template's example interventions evaluate completely against a no-change baseline", () => {
    for (const t of BUSINESS_TEMPLATES) {
      const alts = exampleAlternatives(t, NOW);
      expect(alts.filter((a) => a.isBaseline)).toHaveLength(1);
      const r = evaluate({
        decisionId: "d",
        decisionRevision: 1,
        objectiveLabel: t.objectiveName,
        currency: "EUR",
        horizonDays: 90,
        asOf: NOW,
        grossMarginBps: t.grossMarginBps,
        cohortSize: 100,
        goal: { basis: "incremental_revenue", direction: "increase", target: t.interventionTargetMajor * 100, label: "" },
        policy: { maxLossProbability: 0.3, maxSpendMinor: 10_000_000, maxDownsideExposureMinor: 10_000_000, maxInputAgeDays: 45 },
        alternatives: alts,
      });
      expect(r.status).toBe("complete");
    }
  });
});

describe("buildWorkspace", () => {
  it("creates a company-specific tenant with only its admin, in the chosen currency and calendar", () => {
    const w = buildWorkspace(input(), NOW, ids);
    expect(w.tenant.name).toBe("Acme");
    expect(w.members).toEqual([expect.objectContaining({ name: "Sam Rivera", role: "admin", tenantId: w.tenant.id })]);
    expect(w.profile).toEqual(expect.objectContaining({ currency: "EUR", timezone: "Europe/Lisbon", fiscalYearStartMonth: 4, businessModel: "subscription", version: 1 }));
    expect(w.policy.version).toBe(1);
    expect(w.rows).toEqual([]);
    expect(w.decisions).toEqual([]);
  });

  it("starts the template goal as a draft that names what it still needs", () => {
    const w = buildWorkspace(input({ businessModel: "commerce" }), NOW, ids);
    const o = w.objectives[0];
    const t = BUSINESS_TEMPLATES.find((x) => x.model === "commerce")!;
    expect(o.name).toBe(t.objectiveName);
    expect(o.ownerId).toBe(w.members[0].id);
    expect(o.guardrails).toEqual(t.guardrails);
    expect(objectiveReadiness(o, w.metrics.find((m) => m.id === o.metricId)!, 0)).toEqual(expect.arrayContaining(["source", "baselinePeriod", "target"]));
  });

  it("with sample data, adds a team, history and decisions in several states", () => {
    const w = buildWorkspace(input({ sampleData: true, businessModel: "services", currency: "JPY" }), NOW, ids);
    expect(w.members.length).toBeGreaterThan(4);
    expect(new Set(w.members.map((m) => m.role))).toEqual(new Set(["admin", "executive", "lead", "operator", "finance", "auditor"]));
    expect(w.rows.length).toBeGreaterThan(100);
    expect(w.rows.every((r) => r.currency === "JPY" && Number.isSafeInteger(r.amountMinor))).toBe(true);
    const states = new Set(w.decisions.map((d) => d.state));
    for (const s of ["AwaitingApproval", "Executing", "Measuring", "Debriefed"]) expect(states.has(s as never)).toBe(true);
    const o = w.objectives[0];
    expect(objectiveReadiness(o, w.metrics.find((m) => m.id === o.metricId)!, w.rows.length)).toEqual([]);
    expect(w.outcomes.length).toBeGreaterThan(0);
    expect(w.forecasts.length).toBeGreaterThan(3);
  });

  it("the sample goal is a stretch: the trend alone is below even odds", async () => {
    const { EnterpriseApi } = await import("../src/api");
    const { emptyState } = await import("../src/host");
    const w = buildWorkspace(input({ sampleData: true }), NOW, ids);
    const st = emptyState();
    Object.assign(st, { tenants: [w.tenant], members: w.members, profiles: [w.profile], policies: [w.policy], metrics: w.metrics, objectives: w.objectives, rows: w.rows, imports: w.imports, decisions: w.decisions, evaluations: w.evaluations, approvals: w.approvals, work: w.work, outcomes: w.outcomes, moats: w.moats, forecasts: w.forecasts, tasks: w.tasks });
    const api = new EnterpriseApi(st, { now: () => NOW });
    const today = (await api.handle(w.members[0].id, { method: "GET", path: `/v1/workspaces/${w.tenant.workspaceId}/today` })).body as { winning: { goals: { pWin: number; pWinTrendOnly: number }[] } };
    const g = today.winning.goals[0];
    expect(g.pWinTrendOnly).toBeLessThan(0.5);
    expect(g.pWin).toBeGreaterThan(g.pWinTrendOnly);
  });

  it("sample data shows Compass at work: decision tasks, a blocked task and a debriefed one that left an advantage", () => {
    const w = buildWorkspace(input({ sampleData: true }), NOW, ids);
    for (const wl of w.work) expect(w.tasks.some((t) => t.workId === wl.id && t.key === wl.compassTaskId)).toBe(true);
    expect(w.tasks.some((t) => t.status === "blocked" && t.blockers.some((b) => !b.resolvedAt))).toBe(true);
    const deb = w.tasks.find((t) => t.debrief?.assetLeft);
    expect(deb).toBeTruthy();
    expect(w.moats.some((m) => m.taskId === deb!.id)).toBe(true);
    expect(new Set(w.tasks.map((t) => t.key)).size).toBe(w.tasks.length);
  });

  it("sample decisions are evaluated against the goal's forecast, so every option has P(Win | π, E)", () => {
    const w = buildWorkspace(input({ sampleData: true }), NOW, ids);
    for (const e of w.evaluations) {
      expect(e.snapshot.goalForecast).toEqual(expect.objectContaining({ target: expect.any(Number), sd: expect.any(Number) }));
      expect(e.result!.rankedBy).toBe("p_win");
      for (const a of e.result!.alternatives) expect(a.pWin).toBeGreaterThanOrEqual(0);
    }
  });

  it("an empty workspace starts with one starter task per first-cycle step, owned by the admin", () => {
    const w = buildWorkspace(input(), NOW, ids);
    expect(w.tasks.length).toBeGreaterThanOrEqual(3);
    expect(w.tasks.every((t) => t.ownerId === w.members[0].id && t.status === "todo")).toBe(true);
  });

  it("uses only the company's own name and clearly labelled sample people", () => {
    const w = buildWorkspace(input({ sampleData: true }), NOW, ids);
    expect(w.tenant.name).toBe("Acme");
    for (const m of w.members.filter((x) => x.role !== "admin")) expect(m.title).toMatch(/\(sample\)$/);
  });
});

describe("validateWorkspaceInput", () => {
  it("accepts a well-formed input and rejects bad currency, model, month or names", () => {
    expect(validateWorkspaceInput(input())).toEqual([]);
    expect(validateWorkspaceInput(input({ currency: "euro" }))).toContain("currency");
    expect(validateWorkspaceInput(input({ businessModel: "bank" as never }))).toContain("businessModel");
    expect(validateWorkspaceInput(input({ fiscalYearStartMonth: 13 }))).toContain("fiscalYearStartMonth");
    expect(validateWorkspaceInput(input({ companyName: " " }))).toContain("companyName");
    expect(validateWorkspaceInput(input({ admin: { name: "", title: "" } }))).toContain("admin.name");
    expect(validateWorkspaceInput(input({ timezone: "Mars/Olympus" }))).toContain("timezone");
  });
});
