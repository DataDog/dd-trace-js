/**
 * Preserve previously observed workflow runs when GitHub temporarily returns a
 * partial or empty response. Runs for a commit cannot disappear, but their state
 * can change when they complete or are retried.
 *
 * @template {{ id: number, run_attempt?: number }} T
 * @param {T[]} previous
 * @param {T[]} current
 * @returns {T[]}
 */
export function mergeWorkflowRuns (previous, current) {
  const runs = new Map(previous.map(run => [run.id, run]))
  for (const run of current) {
    const existing = runs.get(run.id)
    if ((run.run_attempt ?? 1) < (existing?.run_attempt ?? 1)) continue
    runs.set(run.id, run)
  }
  return [...runs.values()]
}

/**
 * @template {{ id: number, status: string, conclusion: string|null, run_attempt?: number }} T
 * @param {T[]} runs
 * @param {Set<number>} retriedRunIds
 * @returns {T[]}
 */
export function markWorkflowRunsForRetry (runs, retriedRunIds) {
  return runs.map(run => retriedRunIds.has(run.id)
    ? { ...run, status: 'queued', conclusion: null, run_attempt: (run.run_attempt ?? 1) + 1 }
    : run)
}

/** @param {Array<{ status: string }>} runs */
export function hasPendingWorkflowRuns (runs) {
  return runs.length === 0 || runs.some(run => run.status !== 'completed')
}
