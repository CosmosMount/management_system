export const DEFAULT_BUDGET_PERIOD = "2026";

export function currentBudgetPeriod(): string {
  return DEFAULT_BUDGET_PERIOD;
}

export function formatBudgetPoolLabel(team: string, techGroup: string): string {
  return `${team} · ${techGroup}`;
}
