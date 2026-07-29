'use strict'

const assert = require('node:assert/strict')

const sum = require('./dependency')
const {
  assertNoProbeSetAfterRelease,
  releaseHeldProbeRemoval,
  waitForFirstProbeRemoval,
} = require('./hold-probe-removal')

describe('dynamic-instrumentation', () => {
  it('exhausts the first retry', function () {
    assert.strictEqual(sum(11, 3), 14)
  })

  it('exhausts a later retry from the same location', function () {
    assert.strictEqual(sum(11, 3), 14)
  })

  it('does not reinstall the canceled probe', async function () {
    this.timeout(15_000)
    releaseHeldProbeRemoval()
    await waitForFirstProbeRemoval()
    assertNoProbeSetAfterRelease()
  })
})
