'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/core')

describe('flag evaluation concurrent requests', () => {
  let clock
  let writer
  let requests

  beforeEach(() => {
    clock = sinon.useFakeTimers()
    requests = []
    // Keep the real request helper; replace only the socket boundary.
    const request = proxyquire('../../../src/exporters/common/request', {
      http: {
        request (options, onResponse) {
          const req = new EventEmitter()
          const attempt = { headers: options.headers, body: '', req, onResponse }
          Object.assign(req, {
            setTimeout () {},
            write (chunk) { attempt.body += chunk },
            end () {},
          })
          requests.push(attempt)
          return req
        },
      },
      './retry': { getMaxAttempts: () => 2, getRetryDelay: () => 10 },
    })
    const Base = proxyquire('../../../src/openfeature/writers/base', {
      '../../exporters/common/request': request,
    })
    const Consumer = proxyquire('../../../src/openfeature/writers/flag-evaluation-consumer', { './base': Base })
    const url = new URL('http://localhost:8126')
    writer = new Consumer({ url, service: 'test' })
    writer.setEnabled(true, { url, basePath: '' })
  })

  afterEach(() => {
    writer.destroy()
    clock.restore()
  })

  function respond (attempt, statusCode) {
    const res = Object.assign(new EventEmitter(), {
      statusCode, headers: {}, setTimeout () {},
    })
    attempt.onResponse(res)
    res.emit('end')
  }

  for (const fallback of [false, true]) {
    it(`isolates each envelope's headers and does not retry ambiguous failures, fallback=${fallback}`, () => {
      if (fallback) {
        writer.setEnabled(true, {
          url: new URL('http://localhost:8126'),
          basePath: '',
          fallback: { url: new URL('http://localhost:8127'), basePath: '' },
        })
      }
      for (const flagKey of ['small', 'larger-🚀-flag']) {
        writer.enqueue({ flagKey, timestamp: 100 })
        writer.flush()
      }
      assert.strictEqual(requests.length, 2)
      let first = requests[0]
      let second = requests[1]
      if (fallback) {
        respond(first, 404)
        respond(second, 404)
        assert.strictEqual(requests.length, 4)
        first = requests[2]
        second = requests[3]
      }
      first.req.emit('error', Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }))
      respond(second, 202)
      clock.tick(10)
      assert.strictEqual(requests.length, fallback ? 4 : 2)
      assert.notStrictEqual(Buffer.byteLength(first.body), Buffer.byteLength(second.body))
      assert.notStrictEqual(first.headers, second.headers)
      assert.strictEqual(first.headers['Content-Length'], Buffer.byteLength(first.body))
      assert.strictEqual(second.headers['Content-Length'], Buffer.byteLength(second.body))
    })
  }
})
