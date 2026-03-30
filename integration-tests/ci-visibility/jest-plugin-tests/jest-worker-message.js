'use strict'

const assert = require('node:assert/strict')
const { parentPort } = require('node:worker_threads')

if (parentPort) {
  parentPort.postMessage({ source: 'jest-worker-message' })
}

describe('jest-worker-message', () => {
  it('passes after sending a non-array worker message', () => {
    assert.strictEqual(true, true)
  })
})
