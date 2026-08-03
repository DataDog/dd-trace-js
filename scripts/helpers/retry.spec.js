'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const retry = require('./retry')

const noSleep = () => {}

describe('retry', () => {
  it('returns the result without retrying when the first attempt succeeds', () => {
    let calls = 0
    const result = retry(() => {
      calls++
      return 'ok'
    }, { sleep: noSleep })
    assert.equal(result, 'ok')
    assert.equal(calls, 1)
  })

  it('retries until an attempt succeeds', () => {
    let calls = 0
    const result = retry(() => {
      calls++
      if (calls < 3) throw new Error('boom')
      return 'ok'
    }, { sleep: noSleep })
    assert.equal(result, 'ok')
    assert.equal(calls, 3)
  })

  it('throws the last error after exhausting every attempt', () => {
    let calls = 0
    assert.throws(
      () => retry(() => {
        calls++
        throw new Error(`boom ${calls}`)
      }, { attempts: 4, sleep: noSleep }),
      /boom 4/
    )
    assert.equal(calls, 4)
  })

  it('backs off exponentially from the base delay between attempts', () => {
    const delays = []
    assert.throws(() => retry(() => {
      throw new Error('boom')
    }, { attempts: 4, baseDelayMs: 5000, sleep: ms => delays.push(ms) }))
    assert.deepEqual(delays, [5000, 10_000, 20_000])
  })

  it('reports each retry through onRetry before sleeping', () => {
    const events = []
    assert.throws(() => retry(() => {
      throw new Error('boom')
    }, {
      attempts: 3,
      baseDelayMs: 1000,
      onRetry: (error, attempt, delayMs) => events.push({ message: error.message, attempt, delayMs }),
      sleep: noSleep,
    }))
    assert.deepEqual(events, [
      { message: 'boom', attempt: 1, delayMs: 1000 },
      { message: 'boom', attempt: 2, delayMs: 2000 },
    ])
  })
})
