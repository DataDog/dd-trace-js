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

function wait (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
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

describe('vitest-test-concurrent-hook-http', () => {
  beforeEach(async () => {
    const statusCode = await httpRequest('/info')
    expect(statusCode).toBe(200)
  })

  afterEach(async () => {
    const statusCode = await httpRequest('/info')
    expect(statusCode).toBe(200)
  })

  test.concurrent('first concurrent hook http is linked to first test span', async () => {
    await wait(30)
    const statusCode = await httpRequest('/info')
    expect(statusCode).toBe(200)
  })

  test.concurrent('second concurrent hook http is linked to second test span', async () => {
    await wait(10)
    const statusCode = await httpRequest('/info')
    expect(statusCode).toBe(200)
  })
})

describe.concurrent('vitest-describe-concurrent-hook-http', () => {
  beforeEach(async () => {
    const statusCode = await httpRequest('/info')
    expect(statusCode).toBe(200)
  })

  afterEach(async () => {
    const statusCode = await httpRequest('/info')
    expect(statusCode).toBe(200)
  })

  test('first inherited concurrent hook http is linked to first test span', async () => {
    await wait(30)
    const statusCode = await httpRequest('/info')
    expect(statusCode).toBe(200)
  })

  test('second inherited concurrent hook http is linked to second test span', async () => {
    await wait(10)
    const statusCode = await httpRequest('/info')
    expect(statusCode).toBe(200)
  })
})

describe('vitest-mixed-concurrent-hook-http', () => {
  beforeEach(async () => {
    const statusCode = await httpRequest('/info')
    expect(statusCode).toBe(200)
  })

  afterEach(async () => {
    const statusCode = await httpRequest('/info')
    expect(statusCode).toBe(200)
  })

  test('serial hook http is linked to serial test span', async () => {
    await wait(5)
    const statusCode = await httpRequest('/info')
    expect(statusCode).toBe(200)
  })

  test.concurrent('first mixed concurrent hook http is linked to first test span', async () => {
    await wait(30)
    const statusCode = await httpRequest('/info')
    expect(statusCode).toBe(200)
  })

  test.concurrent('second mixed concurrent hook http is linked to second test span', async () => {
    await wait(10)
    const statusCode = await httpRequest('/info')
    expect(statusCode).toBe(200)
  })
})

describe('vitest-test-before-each-cleanup-http', () => {
  beforeEach(async () => {
    const statusCode = await httpRequest('/info')
    expect(statusCode).toBe(200)

    return async () => {
      const cleanupStatusCode = await httpRequest('/info')
      expect(cleanupStatusCode).toBe(200)
    }
  })

  test('beforeEach cleanup http is linked to test span', () => {
    expect(true).toBe(true)
  })
})
