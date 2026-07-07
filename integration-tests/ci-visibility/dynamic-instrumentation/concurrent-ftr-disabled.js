'use strict'

const assert = require('node:assert/strict')

const sum = require('./dependency')

let attempt = 0

function wait (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('dynamic instrumentation with concurrent tests', () => {
  it('serial retry does not use Failed Test Replay', () => {
    if (attempt++ === 0) {
      assert.strictEqual(sum(11, 3), 14)
    } else {
      assert.strictEqual(sum(1, 3), 4)
    }
  })

  test.concurrent('concurrent test disables Failed Test Replay for the file', async () => {
    await wait(1)
    assert.strictEqual(sum(1, 3), 4)
  })
})
