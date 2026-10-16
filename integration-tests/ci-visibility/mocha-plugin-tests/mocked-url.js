'use strict'

describe('mocked global URL', () => {
  const originalUrl = globalThis.URL
  let timer

  afterEach(() => {
    clearTimeout(timer)
    globalThis.URL = originalUrl
  })

  it('continues reporting while DogStatsD telemetry is flushed', function (done) {
    this.timeout(15_000)
    globalThis.URL = () => {}

    // Keep the mock active across the automatic 10-second CustomMetrics telemetry flush.
    timer = setTimeout(() => {
      done(process.env.MOCKED_URL_TEST_FAIL === '1' ? new Error('expected test failure') : undefined)
    }, 11_000)
  })
})
