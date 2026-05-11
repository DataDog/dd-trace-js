'use strict'

/* eslint-disable import/order, n/no-missing-require, n/no-unsupported-features/node-builtins */

const assert = require('node:assert/strict')
const http = require('node:http')
const { after, afterEach, before, beforeEach, describe, it } = require('node:test')
const tracer = require('dd-trace')

let server
let baseUrl

function get (url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      res.resume()
      res.on('end', resolve)
    }).on('error', reject)
  })
}

before(async () => {
  server = http.createServer((req, res) => {
    res.end('ok')
  })
  await new Promise(resolve => {
    server.listen(0, '127.0.0.1', resolve)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise(resolve => server.close(resolve))
})

beforeEach(async () => {
  tracer.scope().active()?.setTag('test.before_each_http', 'true')
  await get(`${baseUrl}/before`)
})

afterEach(async () => {
  tracer.scope().active()?.setTag('test.after_each_http', 'true')
  await get(`${baseUrl}/after`)
})

describe('node test http context', () => {
  it('parents http spans to the active test span', async () => {
    tracer.scope().active()?.setTag('test.http_body', 'true')
    await get(`${baseUrl}/body`)
    assert.ok(true)
  })
})
