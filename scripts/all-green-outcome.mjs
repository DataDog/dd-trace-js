const failureConclusions = new Set(['failure', 'timed_out'])

export function getAllGreenOutcome (runs, staleFailureRunIds) {
  let outcome = 'success'

  for (const run of runs) {
    if (staleFailureRunIds.has(run.id)) continue
    if (run.conclusion === 'cancelled') return 'cancelled'
    if (failureConclusions.has(run.conclusion)) outcome = 'failure'
  }

  return outcome
}
