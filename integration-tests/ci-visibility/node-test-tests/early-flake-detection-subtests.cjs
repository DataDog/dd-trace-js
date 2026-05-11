'use strict'

/* eslint-disable import/order, n/no-missing-require, n/no-unsupported-features/node-builtins */

const assert = require('node:assert/strict')
const { describe, it } = require('node:test')
const tracer = require('dd-trace')

let parentAttempts = 0
let childAttempts = 0

function setAttemptTag (name, count) {
  tracer.scope().active()?.setTag(`test.${name}_attempt`, String(count))
}

describe('early flake detection subtests', () => {
  it('does not retry parent tests that create subtests', async (testContext) => {
    parentAttempts++
    setAttemptTag('parent', parentAttempts)

    await testContext.test('retries child subtests', () => {
      childAttempts++
      setAttemptTag('child', childAttempts)

      if (childAttempts === 1) {
        assert.fail('first child attempt fails')
      }
    })
  })
})
