import { describe, expect, it } from "vitest";
import type { Task } from "../src/api-types";
import { rankTasks, taskCalibration } from "../src/compass";

const NOW = "2026-11-25T08:00:00.000Z";
const task = (over: Partial<Task>): Task => ({
  id: over.id ?? "t", key: "CMP-0001", tenantId: "x", title: "t", description: "", status: "todo", ownerId: null, createdBy: "u", doneWhen: [], dueAt: null, goalId: null, decisionId: null, workId: null, actionId: null,
  impact: 3, confidence: 0.5, effortDays: 2, moat: null, blockers: [], createdAt: NOW, updatedAt: NOW, startedAt: null, completedAt: null, evidenceNote: null, debrief: null, revision: 1, ...over,
});

describe("Compass ranking", () => {
  it("score = impact × confidence × (1 + ¼·moat strength) ÷ effort × urgency, highest first", () => {
    const r = rankTasks([task({ id: "a", impact: 2 }), task({ id: "b", impact: 5 }), task({ id: "c", impact: 4, moat: { kind: "integration", note: "", strength: 4 } })], NOW);
    expect(r.map((x) => x.task.id)).toEqual(["c", "b", "a"]);
    expect(r[0].score).toBeCloseTo((4 * 0.5 * 2) / 2, 12);
  });
  it("explains each rank in plain words", () => {
    const [x] = rankTasks([task({ impact: 5, effortDays: 0.5, moat: { kind: "decision_data", note: "", strength: 3 }, dueAt: "2026-11-27T00:00:00.000Z" })], NOW);
    expect(x.reasons).toEqual(expect.arrayContaining(["High impact", "Quick win", "Builds a lasting advantage", "Due in 2 days"]));
  });
  it("overdue work rises; blocked work sinks and says why; done work leaves the list", () => {
    const r = rankTasks([task({ id: "late", dueAt: "2026-11-20T00:00:00.000Z" }), task({ id: "plain" }), task({ id: "stuck", status: "blocked", blockers: [{ id: "b", text: "Waiting on legal", createdAt: NOW, resolvedAt: null }] }), task({ id: "done", status: "done" })], NOW);
    expect(r.map((x) => x.task.id)).toEqual(["late", "plain", "stuck"]);
    expect(r[0].reasons).toContain("Overdue");
    expect(r[2].reasons).toContain("Blocked: Waiting on legal");
  });
  it("calibration compares predicted with actual impact on debriefed tasks", () => {
    const at = NOW;
    const c = taskCalibration([task({ impact: 4, debrief: { actualImpact: 2, lesson: "", assetLeft: null, at, by: "u" } }), task({ impact: 3, debrief: { actualImpact: 4, lesson: "", assetLeft: null, at, by: "u" } }), task({ impact: 5 })]);
    expect(c).toEqual({ n: 2, meanAbsError: 1.5, bias: -0.5 });
    expect(taskCalibration([])).toEqual({ n: 0, meanAbsError: null, bias: null });
  });
});
