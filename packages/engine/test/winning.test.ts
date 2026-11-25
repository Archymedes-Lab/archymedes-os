import { describe, expect, it } from "vitest";
import { evaluate } from "../src/evaluator";
import { DEFAULT_POLICY, revenueSnapshot } from "../src/fixtures";
import { goalWinProbability, loopStrength, optionWinProbability } from "../src/winning";

describe("Winning = Good Decisions × Effective Execution × Continuous Learning", () => {
  it("loop strength is the product P(D)·P(A|D)·P(L|D,A), Laplace-smoothed from counts", () => {
    const l = loopStrength({ decided: 8, goodDecisions: 6, delivered: 4, executed: 5, learned: 2, measurable: 4 });
    expect(l.pD).toBeCloseTo(7 / 10, 12);
    expect(l.pAgivenD).toBeCloseTo(5 / 7, 12);
    expect(l.pLgivenDA).toBeCloseTo(3 / 6, 12);
    expect(l.product).toBeCloseTo((7 / 10) * (5 / 7) * (3 / 6), 12);
    expect(l.weakest).toBe("learning");
  });

  it("with no history every factor is an uninformed 50%, never 0 or 1", () => {
    const l = loopStrength({ decided: 0, goodDecisions: 0, executed: 0, delivered: 0, measurable: 0, learned: 0 });
    expect([l.pD, l.pAgivenD, l.pLgivenDA]).toEqual([0.5, 0.5, 0.5]);
    expect(l.product).toBeCloseTo(0.125, 12);
  });

  it("a weak link limits the whole loop: one factor at 10% caps the product at 10%", () => {
    const l = loopStrength({ decided: 98, goodDecisions: 98, executed: 98, delivered: 98, measurable: 98, learned: 9 });
    expect(l.product).toBeLessThanOrEqual(l.pLgivenDA);
    expect(l.weakest).toBe("learning");
  });

  it("goal P(Win|X): projection plus expected lift of committed work, normal approximation", () => {
    expect(goalWinProbability({ mean: 100, sd: 10, target: 100, direction: "increase" }, [])).toBeCloseTo(0.5, 6);
    const lifted = goalWinProbability({ mean: 100, sd: 10, target: 110, direction: "increase" }, [{ ev: 10, variance: 0, pExec: 1 }]);
    expect(lifted).toBeCloseTo(0.5, 6);
    const halfDone = goalWinProbability({ mean: 100, sd: 10, target: 110, direction: "increase" }, [{ ev: 10, variance: 0, pExec: 0.5 }]);
    expect(halfDone).toBeLessThan(0.5);
    expect(goalWinProbability({ mean: 90, sd: 0, target: 100, direction: "increase" }, [])).toBe(0);
    expect(goalWinProbability({ mean: 90, sd: 5, target: 100, direction: "decrease" }, [])).toBeGreaterThan(0.95);
  });

  it("option P(Win|π,E) mixes scenarios and execution risk", () => {
    const g = { mean: 100, sd: 10, target: 110, direction: "increase" as const };
    const doNothing = optionWinProbability(g, [{ p: 1, delta: 0 }], 1);
    const surely = optionWinProbability(g, [{ p: 1, delta: 10 }], 1);
    const risky = optionWinProbability(g, [{ p: 0.5, delta: 0 }, { p: 0.5, delta: 20 }], 1);
    expect(surely).toBeCloseTo(0.5, 6);
    expect(doNothing).toBeLessThan(surely);
    expect(risky).toBeGreaterThan(doNothing);
    expect(optionWinProbability(g, [{ p: 1, delta: 10 }], 0)).toBeCloseTo(doNothing, 12);
  });
});

describe("Orion ranks by π* = argmax P(Win | π, E) when the goal has a forecast", () => {
  const asOf = "2026-11-18T09:00:00.000Z";
  const withForecast = (rankBy?: "p_win" | "expected_profit") =>
    revenueSnapshot({ policy: { ...DEFAULT_POLICY, ...(rankBy ? { rankBy } : {}) }, goalForecast: { mean: 0, sd: 500_000, target: 1_000_000, direction: "increase" }, executionProbability: 1 }, asOf);

  it("reports P(Win) for the baseline and each option", () => {
    const r = evaluate(withForecast());
    const base = r.alternatives.find((a) => a.isBaseline)!;
    const lead = r.alternatives.find((a) => a.id === "alt-lead-follow-up")!;
    expect(base.pWin).not.toBeNull();
    expect(lead.pWin!).toBeGreaterThan(base.pWin!);
    expect(r.rankedBy).toBe("p_win");
  });

  it("can rank by expected profit instead when the company's policy says so", () => {
    expect(evaluate(withForecast("expected_profit")).rankedBy).toBe("expected_profit");
  });

  it("without a goal forecast falls back to expected profit, keeping the §6 fixture exact", () => {
    const r = evaluate(revenueSnapshot());
    expect(r.rankedBy).toBe("expected_profit");
    expect(r.alternatives.every((a) => a.pWin === null)).toBe(true);
    expect(r.alternatives.find((a) => a.id === "alt-lead-follow-up")!.evContributionMinor).toBe(450_000);
  });
});
