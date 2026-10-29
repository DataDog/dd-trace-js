import { describe, test } from 'vitest'
import { noAutoRetry } from 'dd-trace/test-optimization.js'

import { tracked } from './browser-exclusions-ledger.mjs'

function fail () { throw new Error('persistent native browser failure') }

test('direct failure', { retry: 1 }, noAutoRetry(tracked('direct', fail)))
describe('inherited budget', { retry: 1 }, () => {
  test('inherited failure', noAutoRetry(tracked('inherited', fail)))
})
test('control', tracked('control', fail))
