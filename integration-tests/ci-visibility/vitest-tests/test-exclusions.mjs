import { describe, test } from 'vitest'
import { preventFailureSuppression, noAutoRetry } from 'dd-trace/test-optimization.js'

function fail () { throw new Error('excluded failure') }

if (process.env.EXCLUSIONS_MODE === 'policy') {
  test('protected disabled', preventFailureSuppression(fail))
  test('protected quarantine', preventFailureSuppression(fail))
  const protectedCases = test.each([1, 2])
  protectedCases('protected both %s', preventFailureSuppression(noAutoRetry(fail)))
  test('ordinary disabled', noAutoRetry(fail))
  test('ordinary quarantine', noAutoRetry(fail))
  test('protected passing', preventFailureSuppression(() => {}))
  // Verify annotations do not reverse an explicit developer skip.
  test.skip('developer skipped', preventFailureSuppression(noAutoRetry(fail)))
} else if (process.env.EXCLUSIONS_MODE === 'sole') {
  test('sole', preventFailureSuppression(noAutoRetry(fail)))
} else if (process.env.EXCLUSIONS_MODE === 'removed') {
  test('sole', fail)
} else if (process.env.EXCLUSIONS_MODE === 'native-suite') {
  describe('suite retries', { retry: 2 }, () => {
    let executions = 0
    test('native retries', noAutoRetry(() => { if (++executions === 1) fail() }))
  })
} else if (process.env.EXCLUSIONS_MODE === 'concurrent') {
  const excludedCases = test.concurrent.each([1, 2])
  excludedCases('excluded %s', noAutoRetry(fail))
  test.concurrent('control', fail)
} else if (process.env.EXCLUSIONS_MODE === 'native-condition') {
  let executions = 0
  test('native conditional retries', { retry: { count: 2, condition: () => true } }, noAutoRetry(() => {
    if (++executions === 1) fail()
  }))
} else if (process.env.EXCLUSIONS_MODE === 'explicit') {
  let executions = 0
  test('native retries', { retry: 2 }, noAutoRetry(() => { if (++executions === 1) fail() }))
} else if (process.env.EXCLUSIONS_MODE === 'atr') {
  test('excluded', noAutoRetry(fail))
  test('control', fail)
  let executions = 0
  test('protected retry', preventFailureSuppression(() => { if (++executions === 1) fail() }))
} else {
  test('excluded', noAutoRetry(() => {}))
  test('control', () => {})
}
