/**
 * Cost budget enforcement (M14 governance).
 *
 * Evaluates accumulated LLM/agent spend against `policy.budgets`
 * (`maxCostPerRunUsd`, `maxCostPerDayUsd`) and reports breaches. Pure: the
 * caller supplies the current run + day totals (the day total can be sourced
 * from a ledger; see {@link sumUsageCost}). Returns a decision rather than
 * throwing, so the orchestrator chooses how to react (warn vs halt).
 */

import type { AgentUsage } from "../domain/implementationPack/schema.js";
import { roundUsd } from "../shared/utils.js";
import { estimateUsageCostUsd } from "./modelPrices.js";

export interface CostBudget {
  maxCostPerRunUsd?: number | undefined;
  maxCostPerDayUsd?: number | undefined;
}

export interface BudgetCheckInput {
  budget: CostBudget;
  /** Total USD spent in the current run so far. */
  runCostUsd: number;
  /** Total USD spent today (run included), when a ledger is available. */
  dayCostUsd?: number;
}

export interface BudgetBreach {
  scope: "run" | "day";
  limitUsd: number;
  actualUsd: number;
}

export interface BudgetDecision {
  ok: boolean;
  breaches: BudgetBreach[];
  /** A human-readable summary for logs/replies (empty when ok). */
  message: string;
}

export function checkBudget(input: BudgetCheckInput): BudgetDecision {
  const breaches: BudgetBreach[] = [];

  if (input.budget.maxCostPerRunUsd !== undefined && input.runCostUsd > input.budget.maxCostPerRunUsd) {
    breaches.push({ scope: "run", limitUsd: input.budget.maxCostPerRunUsd, actualUsd: roundUsd(input.runCostUsd) });
  }
  if (
    input.budget.maxCostPerDayUsd !== undefined &&
    input.dayCostUsd !== undefined &&
    input.dayCostUsd > input.budget.maxCostPerDayUsd
  ) {
    breaches.push({ scope: "day", limitUsd: input.budget.maxCostPerDayUsd, actualUsd: roundUsd(input.dayCostUsd) });
  }

  const message = breaches
    .map((b) => `${b.scope} cost $${b.actualUsd.toFixed(2)} exceeds budget $${b.limitUsd.toFixed(2)}`)
    .join("; ");

  return { ok: breaches.length === 0, breaches, message };
}

/**
 * Sum the USD cost across a set of agent usages. Exact SDK-reported cost wins;
 * usages with tokens but no cost (the Codex SDK) are estimated from the model
 * price table, so the budget gate is no longer blind to them. Unmeterable
 * usages count as 0.
 */
export function sumUsageCost(usages: Array<AgentUsage | undefined>): number {
  return roundUsd(usages.reduce((total, usage) => total + (estimateUsageCostUsd(usage) ?? 0), 0));
}