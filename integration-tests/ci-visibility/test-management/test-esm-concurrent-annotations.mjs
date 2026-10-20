import { test } from '@jest/globals'
import annotations from 'dd-trace/test-optimization'

if (globalThis.test !== undefined) throw new Error('Jest globals must remain disabled')

const { noAutoRetry, preventFailureSuppression } = annotations
const rows = test.concurrent.each([1, 2])
rows('protected ESM row %s', preventFailureSuppression(noAutoRetry(async () => {
  throw new Error('protected concurrent ESM failure')
})))
