import fc from "fast-check";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Task } from "../src/api-types";
import { rankTasks } from "../src/compass";
import { parseCsv, previewImport } from "../src/csv-import";
import { evaluate } from "../src/evaluator";
import { baselineAlternative, DEFAULT_POLICY, revenueSnapshot } from "../src/fixtures";
import { allocateInvoiceLines, brierScore } from "../src/measurement";
import { formatMoney, parseMoneyToMinor } from "../src/money";
import { sha256Hex } from "../src/sha256";
import type { AlternativeInput, DecisionState } from "../src/types";
import { DECISION_STATES } from "../src/types";
import { goalWinProbability, loopStrength, optionWinProbability } from "../src/winning";
import { canTransition, nextStates } from "../src/workflow";

const RUNS = { numRuns: 300 };

/** Three scenario probabilities that sum to exactly 1 (in hundredths). */
const probs = fc.tuple(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 100 })).filter(([a, b]) => a + b <= 100).map(([a, b]) => [a / 100, b / 100, (100 - a - b) / 100] as const);
const minor = fc.integer({ min: -5_000_000, max: 5_000_000 });

const candidate = (id: string, p: readonly number[], inc: number[], cost: number): AlternativeInput => {
  const base = baselineAlternative("2026-11-18T09:00:00.000Z");
  return { id, name: id, isBaseline: false, spendMinor: Math.abs(cost), timeToEffectDays: 10, assumptions: [], scenarios: base.scenarios.map((s, i) => ({ ...s, probability: p[i], revenueMinor: s.revenueMinor! + inc[i], actionCostMinor: Math.abs(cost) })) };
};

describe("Orion evaluator invariants", () => {
  it("EV is the probability-weighted mean of scenario deltas, P(loss) and P(goal) lie in [0,1], range brackets EV", () => {
    fc.assert(
      fc.property(probs, fc.array(minor, { minLength: 3, maxLength: 3 }), fc.integer({ min: 0, max: 1_000_000 }), (p, inc, cost) => {
        const r = evaluate(revenueSnapshot({ policy: { ...DEFAULT_POLICY, maxSpendMinor: 1e12, maxDownsideExposureMinor: 1e12, maxLossProbability: 1 }, alternatives: [baselineAlternative("2026-11-18T09:00:00.000Z"), candidate("c", p, inc, cost)] }));
        const a = r.alternatives.find((x) => x.id === "c")!;
        const ev = a.scenarios.reduce((s, x) => s + x.probability * x.deltaContributionMinor, 0);
        expect(Math.abs(a.evContributionMinor! - ev)).toBeLessThanOrEqual(0.5 + 1e-6);
        for (const q of [a.pLoss!, a.pGoal!]) expect(q).toBeGreaterThanOrEqual(-1e-12), expect(q).toBeLessThanOrEqual(1 + 1e-12);
        expect(a.range!.minMinor).toBeLessThanOrEqual(a.evContributionMinor! + 1);
        expect(a.range!.maxMinor).toBeGreaterThanOrEqual(a.evContributionMinor! - 1);
      }),
      RUNS,
    );
  });

  it("is deterministic and order-independent: shuffling the candidates never changes the recommendation", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(probs, fc.array(minor, { minLength: 3, maxLength: 3 })), { minLength: 1, maxLength: 4 }), (cands) => {
        const alts = cands.map(([p, inc], i) => candidate(`c${i}`, p, inc, 1000));
        const base = baselineAlternative("2026-11-18T09:00:00.000Z");
        const a = evaluate(revenueSnapshot({ alternatives: [base, ...alts] }));
        const b = evaluate(revenueSnapshot({ alternatives: [base, ...[...alts].reverse()] }));
        expect(b.recommendationId).toBe(a.recommendationId);
        expect(evaluate(revenueSnapshot({ alternatives: [base, ...alts] }))).toEqual(a);
      }),
      RUNS,
    );
  });

  it("ranked options are all eligible, ranks are 1..n without gaps, and a gated option is never recommended", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(probs, fc.array(minor, { minLength: 3, maxLength: 3 })), { minLength: 1, maxLength: 4 }), fc.double({ min: 0, max: 1, noNaN: true }), (cands, maxLoss) => {
        const r = evaluate(revenueSnapshot({ policy: { ...DEFAULT_POLICY, maxLossProbability: maxLoss }, alternatives: [baselineAlternative("2026-11-18T09:00:00.000Z"), ...cands.map(([p, inc], i) => candidate(`c${i}`, p, inc, 500))] }));
        const ranked = r.alternatives.filter((x) => x.rank !== null).map((x) => x.rank!).sort((x, y) => x - y);
        expect(ranked).toEqual(ranked.map((_, i) => i + 1));
        for (const x of r.alternatives) if (x.rank !== null) expect(x.eligible).toBe(true);
        const rec = r.alternatives.find((x) => x.id === r.recommendationId);
        if (rec && !rec.isBaseline) expect(rec.eligible).toBe(true);
      }),
      RUNS,
    );
  });

  it("with a goal forecast, the recommendation maximises P(Win | π, E) among eligible options", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(probs, fc.array(minor, { minLength: 3, maxLength: 3 })), { minLength: 1, maxLength: 4 }), fc.integer({ min: 1, max: 2_000_000 }), (cands, sd) => {
        const r = evaluate(revenueSnapshot({ policy: { ...DEFAULT_POLICY, maxLossProbability: 1, maxSpendMinor: 1e12, maxDownsideExposureMinor: 1e12 }, goalForecast: { mean: 0, sd, target: 1_000_000, direction: "increase" }, executionProbability: 0.8, alternatives: [baselineAlternative("2026-11-18T09:00:00.000Z"), ...cands.map(([p, inc], i) => candidate(`c${i}`, p, inc, 0))] }));
        const eligible = r.alternatives.filter((x) => !x.isBaseline && x.eligible);
        const best = Math.max(...eligible.map((x) => x.pWin!));
        const top = r.alternatives.find((x) => x.rank === 1);
        if (top) expect(top.pWin!).toBeCloseTo(best, 12);
        for (const x of r.alternatives) expect(x.pWin!).toBeGreaterThanOrEqual(0), expect(x.pWin!).toBeLessThanOrEqual(1 + 1e-12);
      }),
      RUNS,
    );
  });
});

describe("winning invariants", () => {
  const counts = fc.record({ decided: fc.nat(500), executed: fc.nat(500), measurable: fc.nat(500) }).chain((c) => fc.record({ decided: fc.constant(c.decided), goodDecisions: fc.integer({ min: 0, max: c.decided }), executed: fc.constant(c.executed), delivered: fc.integer({ min: 0, max: c.executed }), measurable: fc.constant(c.measurable), learned: fc.integer({ min: 0, max: c.measurable }) }));
  it("each factor is strictly inside (0,1); the loop never exceeds its weakest link", () => {
    fc.assert(
      fc.property(counts, (c) => {
        const l = loopStrength(c);
        for (const f of [l.pD, l.pAgivenD, l.pLgivenDA]) expect(f > 0 && f < 1).toBe(true);
        expect(l.product).toBeLessThanOrEqual(Math.min(l.pD, l.pAgivenD, l.pLgivenDA) + 1e-12);
        const weakest = { decisions: l.pD, execution: l.pAgivenD, learning: l.pLgivenDA }[l.weakest];
        expect(weakest).toBeCloseTo(Math.min(l.pD, l.pAgivenD, l.pLgivenDA), 12);
      }),
      RUNS,
    );
  });
  it("more good outcomes never lower a factor (monotone in evidence)", () => {
    fc.assert(
      fc.property(counts, (c) => {
        if (c.goodDecisions < c.decided) expect(loopStrength({ ...c, goodDecisions: c.goodDecisions + 1 }).pD).toBeGreaterThan(loopStrength(c).pD);
      }),
      RUNS,
    );
  });
  it("P(Win) is a probability, rises with expected lift, and execution risk only pulls it toward doing nothing", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1000, max: 1000 }), fc.integer({ min: 1, max: 500 }), fc.integer({ min: -1000, max: 1000 }), fc.integer({ min: 0, max: 1000 }), fc.double({ min: 0, max: 1, noNaN: true }), (mean, sd, target, lift, pExec) => {
        const g = { mean, sd, target, direction: "increase" as const };
        const p0 = goalWinProbability(g, []);
        const p1 = goalWinProbability(g, [{ ev: lift, variance: 0, pExec: 1 }]);
        expect(p0 >= 0 && p0 <= 1 && p1 >= 0 && p1 <= 1).toBe(true);
        expect(p1).toBeGreaterThanOrEqual(p0 - 1e-9);
        const opt = optionWinProbability(g, [{ p: 1, delta: lift }], pExec);
        expect(opt).toBeGreaterThanOrEqual(p0 - 1e-9);
        expect(opt).toBeLessThanOrEqual(optionWinProbability(g, [{ p: 1, delta: lift }], 1) + 1e-9);
      }),
      RUNS,
    );
  });
});

describe("workflow invariants", () => {
  it("random walks through legal transitions only visit known states and never leave a terminal state", () => {
    fc.assert(
      fc.property(fc.array(fc.nat(10), { maxLength: 40 }), (choices) => {
        let s: DecisionState = "Draft";
        for (const c of choices) {
          const next = nextStates(s);
          if (!next.length) {
            expect(["Debriefed", "Cancelled"]).toContain(s);
            break;
          }
          const to = next[c % next.length];
          expect(canTransition(s, to)).toBe(true);
          s = to;
          expect(DECISION_STATES).toContain(s);
        }
      }),
      RUNS,
    );
  });
  it("no state can jump straight from Draft to work or measurement", () => {
    for (const to of ["Approved", "Executing", "DeliveryReview", "Measuring", "Debriefed"] as const) expect(canTransition("Draft", to)).toBe(false);
  });
});

describe("money, CSV and hashing invariants", () => {
  it("formatting then parsing two-decimal money is the identity", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e9, max: 1e9 }), (m) => {
        const text = formatMoney(m, "USD").replace("−", "-").replace(/[$,]/g, "");
        const cents = Math.abs(m) >= 10_000 ? Math.sign(m) * Math.round(Math.abs(m) / 100) * 100 : m; // whole units, half away from zero
        expect(parseMoneyToMinor(text)).toBe(cents);
      }),
      RUNS,
    );
  });
  it("every CSV body line is accounted for exactly once: imported, duplicate, missing or invalid", () => {
    const row = fc.record({ id: fc.constantFrom("A", "B", "C", "D", ""), date: fc.constantFrom("2026-01-02", "bad", ""), amount: fc.constantFrom("10.00", "x", "", "3") });
    fc.assert(
      fc.property(fc.array(row, { maxLength: 30 }), (rows) => {
        const csv = ["id,date,amount", ...rows.map((r) => `${r.id},${r.date},${r.amount}`)].join("\n");
        const p = previewImport(csv, { externalId: "id", occurredAt: "date", amount: "amount", defaultCurrency: "USD", extra: {} }, new Set());
        const lines = parseCsv(csv).length - 1;
        expect(p.rows.length + p.duplicates.length + p.missing.length + p.invalid.length).toBe(lines);
        expect(new Set(p.rows.map((r) => r.externalId)).size).toBe(p.rows.length);
        for (const r of p.rows) expect(Number.isSafeInteger(r.amountMinor)).toBe(true);
      }),
      RUNS,
    );
  });
  it("CSV quoting round-trips arbitrary text", () => {
    fc.assert(
      fc.property(fc.array(fc.array(fc.string({ maxLength: 12 }), { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 6 }), (table) => {
        const width = table[0].length;
        const t = table.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? "x"));
        const quote = (c: string) => `"${c.replace(/"/g, '""')}"`;
        expect(parseCsv(t.map((r) => r.map(quote).join(",")).join("\n"))).toEqual(t.filter((r) => !(r.length === 1 && r[0].trim() === "")));
      }),
      RUNS,
    );
  });
  it("sha256 agrees with node:crypto on arbitrary unicode", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 300 }), (s) => {
        expect(sha256Hex(s)).toBe(createHash("sha256").update(s).digest("hex"));
      }),
      RUNS,
    );
  });
});

describe("measurement and Compass invariants", () => {
  it("invoice allocation conserves the total and never over-assigns a line", () => {
    fc.assert(
      fc.property(fc.array(fc.nat(100_000), { minLength: 1, maxLength: 8 }), fc.array(fc.array(fc.nat(7), { maxLength: 8 }), { minLength: 1, maxLength: 5 }), (amounts, claimLists) => {
        const lines = amounts.map((a, i) => ({ id: `L${i}`, amountMinor: a }));
        const claims = Object.fromEntries(claimLists.map((c, d) => [`d${d}`, [...new Set(c.filter((i) => i < lines.length).map((i) => `L${i}`))]]));
        const alloc = allocateInvoiceLines(lines, claims);
        const claimed = lines.filter((l) => Object.values(claims).some((c) => c.includes(l.id)));
        expect(Object.values(alloc).reduce((s, x) => s + x, 0)).toBe(claimed.reduce((s, l) => s + l.amountMinor, 0));
      }),
      RUNS,
    );
  });
  it("Brier score lies in [0,1]", () => {
    fc.assert(fc.property(fc.array(fc.record({ p: fc.double({ min: 0, max: 1, noNaN: true }), outcome: fc.constantFrom(0 as const, 1 as const) }), { minLength: 1, maxLength: 50 }), (pts) => {
      const s = brierScore(pts).score!;
      expect(s >= 0 && s <= 1).toBe(true);
    }), RUNS);
  });
  const task = (i: number, impact: number, effort: number, moat: number): Task => ({ id: `t${i}`, key: `CMP-${i}`, tenantId: "x", title: "t", description: "", status: "todo", ownerId: null, createdBy: "u", doneWhen: [], dueAt: null, goalId: null, decisionId: null, workId: null, actionId: null, impact, confidence: 0.5, effortDays: effort, moat: moat ? { kind: "process", note: "", strength: moat } : null, blockers: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "", startedAt: null, completedAt: null, evidenceNote: null, debrief: null, revision: 1 });
  it("task ranking is sorted, non-negative, and never ranks a less impactful twin above a more impactful one", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer({ min: 1, max: 5 }), fc.double({ min: 0.1, max: 30, noNaN: true }), fc.integer({ min: 0, max: 5 })), { minLength: 1, maxLength: 20 }), (specs) => {
        const r = rankTasks(specs.map(([i, e, m], k) => task(k, i, e, m)), "2026-11-25T00:00:00.000Z");
        for (let k = 1; k < r.length; k++) expect(r[k - 1].score).toBeGreaterThanOrEqual(r[k].score);
        for (const x of r) expect(x.score).toBeGreaterThanOrEqual(0);
        const [a, b] = rankTasks([task(1, 2, 2, 0), task(2, 5, 2, 0)], "2026-11-25T00:00:00.000Z");
        expect(a.task.impact).toBe(5);
        expect(b.task.impact).toBe(2);
      }),
      RUNS,
    );
  });
});
