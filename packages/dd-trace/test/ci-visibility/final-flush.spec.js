'use strict'

const assert = require('node:assert/strict')

const finalFlushPath = require.resolve('../../src/ci-visibility/final-flush')

describe('final flush timeout', () => {
  const name = '_DD_CIVISIBILITY_FINAL_FLUSH_TIMEOUT_MS'

  /**
   * @param {string} [value]
   */
  function loadTimeout (value) {
    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
    delete require.cache[finalFlushPath]
    return require(finalFlushPath).FINAL_FLUSH_TIMEOUT
  }

  afterEach(() => {
    delete process.env[name]
    delete require.cache[finalFlushPath]
  })

  it('waits a minute by default', () => {
    assert.strictEqual(loadTimeout(), 60_000)
  })

  it('uses the internal override', () => {
    assert.strictEqual(loadTimeout('2000'), 2000)
  })

  it('accepts the smallest positive override and ignores zero', () => {
    assert.strictEqual(loadTimeout('1'), 1)
    assert.strictEqual(loadTimeout('0'), 60_000)
  })
})
