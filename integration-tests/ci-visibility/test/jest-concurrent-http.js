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

function wait (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('jest-test-concurrent-hook-http', () => {
  beforeEach(async () => {
    const statusCode = await httpRequest('/info')
    expect(statusCode).toBe(200)
  })

  afterEach(async () => {
    const statusCode = await httpRequest('/info')
    expect(statusCode).toBe(200)
  })

  test.concurrent('first concurrent body http is linked to first test span', async () => {
    await wait(30)
    const statusCode = await httpRequest('/info')
    expect(statusCode).toBe(200)
  })

  test.concurrent('second concurrent body http is linked to second test span', async () => {
    await wait(10)
    const statusCode = await httpRequest('/info')
    expect(statusCode).toBe(200)
  })
})

describe('jest-test-concurrent-each-http', () => {
  test.concurrent.each([
    ['first each row', 30],
    ['second each row', 10],
  ])('%s http is linked to its test span', async (_label, waitMs) => {
    await wait(waitMs)
    const statusCode = await httpRequest('/info')
    expect(statusCode).toBe(200)
  })
})

describe('jest-duplicate-concurrent-http', () => {
  test.concurrent('duplicate concurrent body http is linked to its test span', async () => {
    await wait(30)
    const statusCode = await httpRequest('/info')
    expect(statusCode).toBe(200)
  })

  test.concurrent('duplicate concurrent body http is linked to its test span', async () => {
    await wait(10)
    const statusCode = await httpRequest('/info')
    expect(statusCode).toBe(200)
  })
})

describe('jest-mixed-concurrent-hook-http', () => {
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

  test.concurrent('first mixed concurrent body http is linked to first test span', async () => {
    await wait(30)
    const statusCode = await httpRequest('/info')
    expect(statusCode).toBe(200)
  })

  test.concurrent('second mixed concurrent body http is linked to second test span', async () => {
    await wait(10)
    const statusCode = await httpRequest('/info')
    expect(statusCode).toBe(200)
  })
})
