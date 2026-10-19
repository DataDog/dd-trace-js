import { expect, test } from 'vitest'
import { noAutoRetry, preventFailureSuppression } from 'dd-trace/test-optimization.js'

function fail () { throw new Error('protected browser failure') }
const each = test.each([1, 2])
each('combined %s', preventFailureSuppression(noAutoRetry(fail)))
test('quarantined exclusion', noAutoRetry(fail))
test('disabled exclusion', noAutoRetry(fail))
test('protected retries', preventFailureSuppression(fail))
test('protected passing', preventFailureSuppression(noAutoRetry(() => {})))
let executions = 0
test('native retry', { retry: 2 }, noAutoRetry(() => { expect(++executions).toBeGreaterThan(1) }))
// Annotated tests still honor explicit developer skips.
test.skip('developer skip', preventFailureSuppression(noAutoRetry(fail)))
test('ordinary control', fail)
