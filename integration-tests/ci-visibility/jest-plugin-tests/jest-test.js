'use strict'

const http = require('http')
const assert = require('assert')

const tracer = require('dd-trace')

const ENDPOINT_URL = process.env.DD_CIVISIBILITY_AGENTLESS_URL ||
  `http://127.0.0.1:${process.env.DD_TRACE_AGENT_PORT}`

describe('jest-test-suite', () => {
  jest.setTimeout(400)

  it('tracer and active span are available', () => {
    assert.notDeepStrictEqual(global._ddtrace, undefined)
    const testSpan = tracer.scope().active()
    assert.notDeepStrictEqual(testSpan, null)
    testSpan.setTag('test.add.stuff', 'stuff')
  })

  it('done', (done) => {
    setTimeout(() => {
      assert.deepStrictEqual(100, 100)
      done()
    }, 50)
  })

  it('done fail', (done) => {
    setTimeout(() => {
      try {
        assert.deepStrictEqual(100, 200)
        done()
      } catch (e) {
        done(e)
      }
    }, 50)
  })

  it('done fail uncaught', (done) => {
    setTimeout(() => {
      assert.deepStrictEqual(100, 200)
      done()
    }, 50)
  })

  it('can do integration http', (done) => {
    const req = http.request(`${ENDPOINT_URL}/info`, { agent: false }, (res) => {
      assert.deepStrictEqual(res.statusCode, 200)
      done()
    })
    req.end()
  })
  // only run for jest-circus tests
  if (jest.retryTimes) {
    const parameters = [[1, 2, 3], [2, 3, 5]]
    it.each(parameters)('can do parameterized test', (a, b, expected) => {
      assert.deepStrictEqual(a + b, expected)
      // They are not modified by dd-trace reading the parameters
      assert.deepStrictEqual(parameters[0], [1, 2, 3])
      assert.deepStrictEqual(parameters[1], [2, 3, 5])
    })
  }

  it('promise passes', () => {
    return new Promise((resolve) =>
      setTimeout(() => {
        assert.deepStrictEqual(100, 100)
        resolve()
      }, 50)
    )
  })

  it('promise fails', () => {
    return new Promise((resolve) =>
      setTimeout(() => {
        assert.deepStrictEqual(100, 200)
        resolve()
      }, 50)
    )
  })
  jest.setTimeout(200)

  it('timeout', () => {
    return new Promise((resolve) =>
      setTimeout(() => {
        assert.deepStrictEqual(100, 100)
        resolve()
      }, 300)
    )
  }, 200)

  it('passes', () => {
    assert.deepStrictEqual(true, true)
  })

  it('fails', () => {
    assert.deepStrictEqual(true, false)
  })
  // eslint-disable-next-line mocha/handle-done-callback
  it('does not crash with missing stack', (done) => {
    setTimeout(() => {
      const error = new Error('fail')
      delete error.stack
      throw error
    }, 100)
  })

  it.skip('skips', () => {
    assert.deepStrictEqual(100, 100)
  })
  it.todo('skips todo')
})

// only run for jest-circus tests
if (jest.retryTimes) {
  describe('jest-circus-test-retry', () => {
    jest.retryTimes(2)
    let retryAttempt = 0

    it('can retry', () => {
      assert.deepStrictEqual(retryAttempt++, 2)
    })
  })
}
