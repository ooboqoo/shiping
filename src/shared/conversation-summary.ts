/** The budget applies only to additional cached summaries, never raw conversation. */
export function normalizeSummarySettings(value: {
  enabled?: unknown
  rounds?: unknown
  budget?: unknown
}) {
  const integer = (n: unknown, fallback: number, min: number, max: number) =>
    typeof n === 'number' && Number.isFinite(n)
      ? Math.min(max, Math.max(min, Math.round(n)))
      : fallback
  return {
    enabled: value.enabled === true,
    rounds: integer(value.rounds, 3, 1, 20),
    budget: integer(value.budget, 1000, 100, 4000)
  }
}
