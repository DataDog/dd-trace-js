const failureConclusions = new Set(['failure', 'timed_out'])

/** @param {string} conclusion */
export function isRetryableConclusion (conclusion) {
  return failureConclusions.has(conclusion)
}

/** @param {number|string} [exitCode] */
export function canPropagateCancellation (exitCode) {
  return exitCode === undefined || exitCode === 0
}

/**
 * @param {Array<{ id: number, conclusion: string }>} runs
 * @param {Set<number>} staleFailureRunIds
 */
export function getAllGreenOutcome (runs, staleFailureRunIds) {
  let outcome = 'success'

  for (const run of runs) {
    if (staleFailureRunIds.has(run.id)) continue
    if (run.conclusion === 'cancelled') return 'cancelled'
    if (failureConclusions.has(run.conclusion)) outcome = 'failure'
  }

  return outcome
}
