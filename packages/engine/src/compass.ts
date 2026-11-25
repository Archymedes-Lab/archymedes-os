import type { Task } from "./api-types";

/**
 * Compass, built in: transparent task ranking and learning from debriefs.
 *
 *   score = impact × confidence × (1 + ¼ · moat strength) ÷ max(effort, ½ day) × urgency
 *
 * urgency = 3 when overdue, 1 + 2 / (1 + days left / 7) when a due date is set, else 1.
 * Blocked tasks count at half so unblocking them is visible work, not hidden.
 */
const DAY = 86_400_000;

export interface RankedTask {
  task: Task;
  score: number;
  reasons: string[];
}

export function rankTasks(tasks: Task[], nowIso: string): RankedTask[] {
  const now = Date.parse(nowIso);
  return tasks
    .filter((t) => t.status !== "done")
    .map((t) => {
      const reasons: string[] = [];
      let urgency = 1;
      if (t.dueAt) {
        const daysLeft = (Date.parse(t.dueAt) - now) / DAY;
        if (daysLeft < 0) {
          urgency = 3;
          reasons.push("Overdue");
        } else {
          urgency = 1 + 2 / (1 + daysLeft / 7);
          if (daysLeft <= 7) reasons.push(`Due in ${Math.max(1, Math.round(daysLeft))} day${Math.round(daysLeft) === 1 ? "" : "s"}`);
        }
      }
      const moat = t.moat?.strength ?? 0;
      let score = ((t.impact * t.confidence * (1 + moat / 4)) / Math.max(t.effortDays, 0.5)) * urgency;
      if (t.impact >= 4) reasons.push("High impact");
      if (t.effortDays <= 1 && t.impact >= 3) reasons.push("Quick win");
      if (moat >= 3) reasons.push("Builds a lasting advantage");
      if (t.decisionId) reasons.push("From an approved decision");
      const open = t.blockers.filter((b) => !b.resolvedAt);
      if (t.status === "blocked" || open.length) {
        score /= 2;
        reasons.push(open.length ? `Blocked: ${open[0].text}` : "Blocked");
      }
      return { task: t, score, reasons };
    })
    .sort((a, b) => b.score - a.score || a.task.createdAt.localeCompare(b.task.createdAt));
}

/** How well the team predicts impact: mean absolute error and bias (actual − predicted) on debriefed tasks. */
export function taskCalibration(tasks: Task[]): { n: number; meanAbsError: number | null; bias: number | null } {
  const done = tasks.filter((t) => t.debrief);
  if (!done.length) return { n: 0, meanAbsError: null, bias: null };
  const diffs = done.map((t) => t.debrief!.actualImpact - t.impact);
  return { n: done.length, meanAbsError: diffs.reduce((s, d) => s + Math.abs(d), 0) / done.length, bias: diffs.reduce((s, d) => s + d, 0) / done.length };
}
