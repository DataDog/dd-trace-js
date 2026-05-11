/* eslint-disable n/no-unsupported-features/node-builtins */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test, { after, afterEach, before, beforeEach, describe, it } from 'node:test'

const require = createRequire(import.meta.url)
const tracer = require('dd-trace')

const suiteEvents = []

before(() => {
  suiteEvents.push('before')
})

after(() => {
  suiteEvents.push('after')
  assert.deepStrictEqual(suiteEvents, ['before', 'after'])
})

beforeEach(() => {
  tracer.scope().active()?.setTag('test.before_each', 'true')
})

afterEach(() => {
  tracer.scope().active()?.setTag('test.after_each', 'true')
})

describe('advanced node test suite', () => {
  it('runs async tests with subtests', async (t) => {
    tracer.scope().active()?.setTag('test.body', 'async')

    await t.test('reports awaited subtests', async () => {
      tracer.scope().active()?.setTag('test.subtest', 'true')
      await Promise.resolve()
      assert.strictEqual(1 + 1, 2)
    })
  })

  it('runs callback style tests', (t, done) => {
    tracer.scope().active()?.setTag('test.callback', 'true')
    setImmediate(done)
  })

  test('runs default test export aliases', () => {
    tracer.scope().active()?.setTag('test.default_export', 'true')
    assert.ok(true)
  })

  test.todo('reports todo tests')
})
