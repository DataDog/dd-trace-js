import { test } from 'vitest'
import { noAutoRetry } from 'dd-trace/ci/test-annotations'

import { tracked } from './browser-exclusions-ledger.mjs'

test('excluded', noAutoRetry(tracked('excluded', () => {})))
test('control', tracked('control', () => {}))
