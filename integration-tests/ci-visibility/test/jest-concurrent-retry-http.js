'use strict'

const http = require('node:http')

const ENDPOINT_URL = process.env.DD_CIVISIBILITY_AGENTLESS_URL ||
  `http://127.0.0.1:${process.env.DD_TRACE_AGENT_PORT}`

function httpRequest (path) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${ENDPOINT_URL}${path}`, { agent: false }, (res) => {
      resolve(res.statusCode)
    })
    req.on('error', reject)
    req.end()
  })
}

function wait (durationMs) {
  return new Promise(resolve => setTimeout(resolve, durationMs))
}

function getRetryingHttpTest (durationMs) {
  let shouldFail = true

  return async () => {
    await wait(durationMs)
    const statusCode = await httpRequest('/info')
    expect(statusCode).toBe(200)
    if (shouldFail) {
      shouldFail = false
      throw new Error('intentional duplicate concurrent retry failure')
    }
  }
}

if (jest.retryTimes) {
  describe('jest-test-concurrent-retry-http', () => {
    let shouldFail = true

    // eslint-disable-next-line sonarjs/stable-tests -- intentional retry verifies concurrent context rebinding
    jest.retryTimes(1)

    test.concurrent('retry body http is linked to current attempt span', async () => {
      const statusCode = await httpRequest('/info')
      expect(statusCode).toBe(200)
      if (shouldFail) {
        shouldFail = false
        throw new Error('intentional concurrent retry failure')
      }
    })
  })

  describe('jest-duplicate-concurrent-retry-http', () => {
    // eslint-disable-next-line sonarjs/stable-tests -- verifies duplicate concurrent context rebinding
    jest.retryTimes(1)

    test.concurrent(
      'duplicate retry body http is linked to current attempt span',
      getRetryingHttpTest(30)
    )
    test.concurrent(
      'duplicate retry body http is linked to current attempt span',
      getRetryingHttpTest(10)
    )
  })
}
