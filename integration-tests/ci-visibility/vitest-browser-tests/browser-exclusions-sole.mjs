import { test } from 'vitest'
import { noAutoRetry, preventFailureSuppression } from 'dd-trace/test-optimization.js'

import { tracked } from './browser-exclusions-ledger.mjs'

test('sole protected failure', preventFailureSuppression(noAutoRetry(tracked('sole', () => {
  throw new Error('protected browser failure')
}))))
