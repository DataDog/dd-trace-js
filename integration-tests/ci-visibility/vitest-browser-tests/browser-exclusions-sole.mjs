import { test } from 'vitest'
import { noAutoRetry, preventFailureSuppression } from 'dd-trace/test-optimization.js'

test('sole protected failure', preventFailureSuppression(noAutoRetry(() => {
  throw new Error('protected browser failure')
})))
