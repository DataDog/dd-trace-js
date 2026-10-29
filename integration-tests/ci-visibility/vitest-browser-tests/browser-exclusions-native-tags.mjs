import { describe, test } from 'vitest'
import { noAutoRetry } from 'dd-trace/test-optimization.js'

import { tracked } from './browser-exclusions-ledger.mjs'

function fail () { throw new Error('persistent native tag failure') }

test('tagged failure', { tags: 'flaky' }, noAutoRetry(tracked('tagged', fail)))
describe('inherited tags', { tags: 'flaky' }, () => {
  test('inherited failure', noAutoRetry(tracked('inherited', fail)))
})
test('control', tracked('control', fail))
