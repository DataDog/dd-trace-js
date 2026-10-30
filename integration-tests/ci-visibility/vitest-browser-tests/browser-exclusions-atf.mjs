import { test } from 'vitest'
import { noAutoRetry } from 'dd-trace/test-optimization.js'

import { tracked } from './browser-exclusions-ledger.mjs'

test('excluded', noAutoRetry(tracked('excluded', () => {})))
test('control', tracked('control', () => {}))
