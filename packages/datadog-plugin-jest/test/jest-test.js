const http = require('http')
const tracer = require('dd-trace')

describe('jest-test-suite', () => {
  // eslint-disable-next-line
  jest.setTimeout(400)
  it('tracer and active span are available', () => {
    expect(global._ddtrace).not.toEqual(undefined)
    const testSpan = tracer.scope().active()
    expect(testSpan).not.toEqual(null)
    testSpan.setTag('test.add.stuff', 'stuff')
  })
  it('done', (done) => {
    setTimeout(() => {
      expect(100).toEqual(100)
      done()
    }, 50)
  })
  it('done fail', (done) => {
    setTimeout(() => {
      try {
        expect(100).toEqual(200)
        done()
      } catch (e) {
        done(e)
      }
    }, 50)
  })
  it('done fail uncaught', (done) => {
    setTimeout(() => {
      expect(100).toEqual(200)
      done()
    }, 50)
  })
  it('can do integration http', (done) => {
    const req = http.request('http://test:123', (res) => {
      expect(res.statusCode).toEqual(200)
      done()
    })
    req.end()
  })
  // only run for jest-circus tests
  // eslint-disable-next-line
  if (jest.retryTimes) {
    it.each([[1, 2, 3], [2, 3, 5]])('can do parameterized test', (a, b, expected) => {
      expect(a + b).toEqual(expected)
    })
  }
  it('promise passes', () => {
    return new Promise((resolve) =>
      setTimeout(() => {
        expect(100).toEqual(100)
        resolve()
      }, 50)
    )
  })
  it('promise fails', () => {
    return new Promise((resolve) =>
      setTimeout(() => {
        expect(100).toEqual(200)
        resolve()
      }, 50)
    )
  })
  // eslint-disable-next-line
  jest.setTimeout(200)
  it('timeout', () => {
    return new Promise((resolve) =>
      setTimeout(() => {
        expect(100).toEqual(100)
        resolve()
      }, 300)
    )
  }, 200)
  it('passes', () => {
    expect(true).toEqual(true)
  })
  it('fails', () => {
    expect(true).toEqual(false)
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
    expect(100).toEqual(100)
  })
  it.todo('skips todo')
})

// only run for jest-circus tests
// eslint-disable-next-line
if (jest.retryTimes) {
  describe('jest-circus-test-retry', () => {
    // eslint-disable-next-line
    jest.retryTimes(2)
    let retryAttempt = 0
    it('can retry', () => {
      expect(retryAttempt++).toEqual(2)
    })
  })
}
