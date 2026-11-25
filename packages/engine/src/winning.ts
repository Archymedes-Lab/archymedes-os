import { normalCdf } from "./forecast";

/**
 * Winning = Good Decisions × Effective Execution × Continuous Learning.
 *
 *   P(D ∩ A ∩ L) = P(D) · P(A | D) · P(L | D, A)
 *
 * Each factor is estimated from what the team actually did, with a Beta(1,1)
 * prior (Laplace smoothing), so a new workspace starts at an honest 50% per
 * factor and moves with evidence. The multiplication is the point: a weak
 * link limits the whole loop.
 */
export interface LoopCounts {
  /** Decisions that reached a choice (submitted for approval or later). */
  decided: number;
  /** Of those: measurable active goal, baseline compared, forecast recorded, independent approval. */
  goodDecisions: number;
  /** Approved decisions whose execution has concluded (delivered, cancelled or overdue). */
  executed: number;
  /** Of those: delivery verified with evidence. */
  delivered: number;
  /** Delivered decisions that are due for measurement. */
  measurable: number;
  /** Of those: outcome reviewed against the forecast, with a lesson and a next step. */
  learned: number;
}

export type LoopLink = "decisions" | "execution" | "learning";

export interface LoopStrength {
  pD: number;
  pAgivenD: number;
  pLgivenDA: number;
  product: number;
  weakest: LoopLink;
  counts: LoopCounts;
}

const laplace = (hits: number, n: number) => (hits + 1) / (n + 2);

export function loopStrength(c: LoopCounts): LoopStrength {
  const pD = laplace(c.goodDecisions, c.decided);
  const pAgivenD = laplace(c.delivered, c.executed);
  const pLgivenDA = laplace(c.learned, c.measurable);
  const links: [LoopLink, number][] = [
    ["decisions", pD],
    ["execution", pAgivenD],
    ["learning", pLgivenDA],
  ];
  const weakest = links.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
  return { pD, pAgivenD, pLgivenDA, product: pD * pAgivenD * pLgivenDA, weakest, counts: c };
}

/** The goal metric's projected value at the deadline: mean and standard deviation, plus the target. */
export interface GoalForecast {
  mean: number;
  sd: number;
  target: number;
  direction: "increase" | "decrease";
}

function pMeets(g: GoalForecast, mean: number, variance: number): number {
  const sd = Math.sqrt(Math.max(0, variance));
  if (sd === 0) return g.direction === "increase" ? (mean >= g.target ? 1 : 0) : mean <= g.target ? 1 : 0;
  const pAbove = 1 - normalCdf((g.target - mean) / sd);
  return g.direction === "increase" ? pAbove : 1 - pAbove;
}

/**
 * P(Win | X) for a goal: the trend projection plus the expected effect of
 * committed initiatives, each discounted by its chance of being executed.
 * Independent normal approximation.
 */
export function goalWinProbability(g: GoalForecast, initiatives: { ev: number; variance: number; pExec: number }[]): number {
  let mean = g.mean;
  let variance = g.sd ** 2;
  for (const i of initiatives) {
    mean += i.pExec * i.ev;
    // Var of a Bernoulli(pExec)-gated effect: p·(var + ev²) − (p·ev)².
    variance += i.pExec * (i.variance + i.ev ** 2) - (i.pExec * i.ev) ** 2;
  }
  return pMeets(g, mean, variance);
}

/**
 * P(Win | π, E) for one course of action: a mixture over its scenarios, where
 * the action happens with probability pExec and otherwise the goal follows its
 * projection alone.
 */
export function optionWinProbability(g: GoalForecast, scenarios: { p: number; delta: number }[], pExec: number): number {
  const without = pMeets(g, g.mean, g.sd ** 2);
  return scenarios.reduce((sum, s) => sum + s.p * (pExec * pMeets(g, g.mean + s.delta, g.sd ** 2) + (1 - pExec) * without), 0);
}
