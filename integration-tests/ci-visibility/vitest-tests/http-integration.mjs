import tracer from 'dd-trace'
import http from 'node:http'
import { describe, test, expect, beforeEach, afterEach } from 'vitest'

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

describe('vitest-test-integration-http', () => {
  test('can do integration http', async () => {
    const testSpan = tracer.scope().active()
    testSpan.setTag('test.custom_tag', 'custom_value')

    const statusCode = await httpRequest('/info')
    expect(statusCode).toBe(200)
  })
})

describe('vitest-test-hook-http', () => {
  beforeEach(async () => {
    const statusCode = await httpRequest('/info')
    expect(statusCode).toBe(200)
  })

  afterEach(async () => {
    const statusCode = await httpRequest('/info')
    expect(statusCode).toBe(200)
  })

  test('hook http is linked to test span', () => {
    expect(true).toBe(true)
  })
})
