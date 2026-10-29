'use strict'

const tracer = require('dd-trace')

describe('mocked global URL', () => {
  const originalUrl = globalThis.URL

  afterEach(() => {
    globalThis.URL = originalUrl
  })

  it('continues reporting while DogStatsD is disabled', () => {
    globalThis.URL = () => {}

    tracer.dogstatsd.flush(true)

    if (process.env.MOCKED_URL_TEST_FAIL === '1') throw new Error('expected test failure')
  })
})
