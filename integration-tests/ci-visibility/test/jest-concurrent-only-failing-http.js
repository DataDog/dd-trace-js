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

describe('jest-concurrent-only-failing-http', () => {
  test.concurrent.only.failing('only failing concurrent body http is linked to test span', async () => {
    const statusCode = await httpRequest('/info')
    expect(statusCode).toBe(200)
    throw new Error('expected failure')
  })
})
