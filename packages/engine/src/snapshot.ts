import { sha256Hex } from "./sha256";
import type { Decision, EnterpriseState, Objective } from "./api-types";
import type { DecisionSnapshot } from "./types";

export { canonicalJson, hashSnapshot } from "./snapshot-hash";

export function sha256(text: string): string {
  return sha256Hex(text);
}

export function currentPolicy(state: EnterpriseState, tenantId: string) {
  return state.policies.filter((p) => p.tenantId === tenantId).sort((a, b) => b.version - a.version)[0];
}

export function currentProfile(state: EnterpriseState, tenantId: string) {
  return state.profiles.filter((p) => p.tenantId === tenantId).sort((a, b) => b.version - a.version)[0];
}

/** Freezes every input the evaluator will see, at one instant, for one revision. */
export function buildSnapshot(state: EnterpriseState, decision: Decision, objective: Objective, asOf: string): { snapshot: DecisionSnapshot; policyVersion: number } {
  const policy = currentPolicy(state, decision.tenantId);
  const profile = currentProfile(state, decision.tenantId);
  return {
    policyVersion: policy.version,
    snapshot: structuredClone({
      decisionId: decision.id,
      decisionRevision: decision.revision,
      objectiveLabel: objective.name,
      currency: profile.currency,
      horizonDays: decision.horizonDays,
      asOf,
      grossMarginBps: profile.grossMarginBps,
      cohortSize: decision.cohortSize,
      goal: objective.interventionGoal,
      policy: policy.evaluation,
      alternatives: decision.alternatives,
    }),
  };
}
