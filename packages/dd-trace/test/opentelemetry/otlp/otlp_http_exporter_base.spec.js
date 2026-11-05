'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const http = require('node:http')

const { describe, it, afterEach, beforeEach } = require('mocha')
const sinon = require('sinon')

require('../../setup/core')

const log = require('../../../src/log')
const OtlpHttpExporterBase = require('../../../src/opentelemetry/otlp/otlp_http_exporter_base')
const { version: tracerVersion } = require('../../../../../package.json')

const proxyEnvironmentNames = [
  'ALL_PROXY',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'all_proxy',
  'https_proxy',
  'http_proxy',
  'no_proxy',
]

describe('OtlpHttpExporterBase', () => {
  let originalEnvironment

  beforeEach(() => {
    originalEnvironment = new Map()
    for (const name of proxyEnvironmentNames) {
      originalEnvironment.set(name, process.env[name])
      delete process.env[name]
    }
  })

  afterEach(() => {
    sinon.restore()
    for (const [name, value] of originalEnvironment) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
  })

  it('sends a User-Agent header identifying the tracer version', () => {
    const exporter = new OtlpHttpExporterBase('https://intake.example/path', undefined, 1000, 'http/protobuf', 'traces')

    assert.strictEqual(exporter.options.headers['User-Agent'], `dd-trace-js/${tracerVersion}`)
  })

  it('does not set an agent for an HTTPS endpoint when no proxy is configured', () => {
    const exporter = new OtlpHttpExporterBase('https://intake.example/path', undefined, 1000, 'http/protobuf', 'traces')

    assert.strictEqual(exporter.options.agent, undefined)
  })

  it('does not set an agent for an HTTP endpoint even when a proxy is configured', () => {
    process.env.https_proxy = 'http://127.0.0.1:9999'

    const exporter = new OtlpHttpExporterBase('http://intake.example/path', undefined, 1000, 'http/protobuf', 'traces')

    assert.strictEqual(exporter.options.agent, undefined)
  })

  it('routes an HTTPS endpoint through the configured proxy agent', () => {
    process.env.https_proxy = 'http://127.0.0.1:9999'

    const exporter = new OtlpHttpExporterBase('https://intake.example/path', undefined, 1000, 'http/protobuf', 'traces')

    assert.ok(exporter.options.agent)
    assert.strictEqual(exporter.options.agent.proxy.hostname, '127.0.0.1')
    assert.strictEqual(exporter.options.agent.proxy.port, '9999')
  })

  describe('flush', () => {
    let exporter
    let requestStub
    let requests

    beforeEach(() => {
      requests = []
      requestStub = sinon.stub(http, 'request').callsFake(() => {
        const request = new EventEmitter()
        request.write = sinon.spy()
        request.end = sinon.spy()
        request.destroy = sinon.spy()
        requests.push(request)
        return request
      })
      sinon.stub(log, 'error')
      exporter = new OtlpHttpExporterBase('http://intake.example/v1/traces', undefined, 1000, 'http/json', 'traces')
    })

    function respond (index = 0, statusCode = 200) {
      const response = new EventEmitter()
      response.statusCode = statusCode
      requestStub.getCall(index).args[1](response)
      return response
    }

    it('completes immediately without active requests', () => {
      const flushed = sinon.spy()

      exporter.flush(flushed)

      sinon.assert.calledOnceWithExactly(flushed)
      exporter.flush()
    })

    it('waits for the response to finish, even outside a serverless environment', () => {
      const exported = sinon.spy()
      const flushed = sinon.spy()
      exporter.sendPayload('{}', exported)
      exporter.flush()
      exporter.flush(flushed)
      sinon.assert.notCalled(flushed)

      const response = respond()
      response.emit('data', '{}')
      sinon.assert.notCalled(flushed)
      response.emit('end')

      sinon.assert.calledOnceWithExactly(exported, { code: 0 })
      sinon.assert.calledOnceWithExactly(flushed, undefined)
      sinon.assert.callOrder(exported, flushed)
    })

    it('accepts the upper successful HTTP status boundary', () => {
      const flushed = sinon.spy()
      exporter.sendPayload('{}', sinon.spy())
      exporter.flush(flushed)

      respond(0, 299).emit('end')

      sinon.assert.calledOnceWithExactly(flushed, undefined)
    })

    it('waits for all boundary requests when responses complete out of order', () => {
      const flushed = sinon.spy()
      exporter.sendPayload('first', sinon.spy())
      exporter.sendPayload('second', sinon.spy())
      exporter.flush(flushed)

      respond(1).emit('end')
      sinon.assert.notCalled(flushed)
      respond(0).emit('end')

      sinon.assert.calledOnceWithExactly(flushed, undefined)
    })

    it('keeps overlapping flush boundaries independent of later requests', () => {
      const firstFlush = sinon.spy()
      const sameBoundary = sinon.spy()
      const secondFlush = sinon.spy()
      exporter.sendPayload('first', sinon.spy())
      exporter.flush(firstFlush)
      exporter.flush(sameBoundary)
      exporter.sendPayload('second', sinon.spy())
      exporter.flush(secondFlush)

      respond(0).emit('end')
      sinon.assert.calledOnceWithExactly(firstFlush, undefined)
      sinon.assert.calledOnceWithExactly(sameBoundary, undefined)
      sinon.assert.notCalled(secondFlush)
      respond(1).emit('end')

      sinon.assert.calledOnce(firstFlush)
      sinon.assert.calledOnce(sameBoundary)
      sinon.assert.calledOnceWithExactly(secondFlush, undefined)
    })

    it('does not report failures from requests started after a flush boundary', () => {
      const firstFlush = sinon.spy()
      const secondFlush = sinon.spy()
      const error = new Error('later request failed')
      exporter.sendPayload('first', sinon.spy())
      exporter.flush(firstFlush)
      exporter.sendPayload('second', sinon.spy())
      exporter.flush(secondFlush)

      requests[1].emit('error', error)
      sinon.assert.notCalled(firstFlush)
      sinon.assert.notCalled(secondFlush)
      respond(0).emit('end')

      sinon.assert.calledOnceWithExactly(firstFlush, undefined)
      sinon.assert.calledOnceWithExactly(secondFlush, error)
    })

    it('reports the first failure after all boundary requests complete', () => {
      const flushed = sinon.spy()
      const firstError = new Error('first failure')
      exporter.sendPayload('first', sinon.spy())
      exporter.sendPayload('second', sinon.spy())
      exporter.flush(flushed)

      requests[1].emit('error', firstError)
      sinon.assert.notCalled(flushed)
      requests[0].emit('error', new Error('second failure'))

      sinon.assert.calledOnceWithExactly(flushed, firstError)
    })

    it('does not retain failures that completed before the flush boundary', () => {
      const flushed = sinon.spy()
      exporter.sendPayload('{}', sinon.spy())
      requests[0].emit('error', new Error('already completed'))

      exporter.flush(flushed)

      sinon.assert.calledOnceWithExactly(flushed)
    })

    for (const statusCode of [199, 300, 503]) {
      it(`reports an HTTP ${statusCode} response to pending flushes`, () => {
        const exported = sinon.spy()
        const flushed = sinon.spy()
        exporter.sendPayload('{}', exported)
        exporter.flush(flushed)
        const response = respond(0, statusCode)
        response.emit('data', 'rejected')
        response.emit('end')

        const error = exported.firstCall.args[0].error
        assert.ok(error instanceof Error)
        assert.strictEqual(error.message, `HTTP ${statusCode}: rejected`)
        sinon.assert.calledOnceWithExactly(exported, { code: 1, error })
        sinon.assert.calledOnceWithExactly(flushed, error)
      })
    }

    for (const failure of ['request error', 'response error', 'timeout']) {
      it(`reports a ${failure} only once, including subsequent completion events`, () => {
        const exported = sinon.spy()
        const flushed = sinon.spy()
        const error = new Error(failure)
        exporter.sendPayload('{}', exported)
        exporter.flush(flushed)
        const response = respond()

        if (failure === 'request error') requests[0].emit('error', error)
        if (failure === 'response error') response.emit('error', error)
        if (failure === 'timeout') requests[0].emit('timeout')
        response.emit('end')
        requests[0].emit('error', new Error('late request error'))

        const reported = exported.firstCall.args[0].error
        if (failure === 'timeout') {
          sinon.assert.calledOnce(requests[0].destroy)
          assert.ok(reported instanceof Error)
          assert.strictEqual(reported.message, 'Request timeout')
        } else {
          assert.strictEqual(reported, error)
        }
        sinon.assert.calledOnceWithExactly(exported, { code: 1, error: reported })
        sinon.assert.calledOnceWithExactly(flushed, reported)
      })
    }

    it('ignores an error after a successful response has completed', () => {
      const exported = sinon.spy()
      const flushed = sinon.spy()
      exporter.sendPayload('{}', exported)
      exporter.flush(flushed)
      respond().emit('end')
      requests[0].emit('error', new Error('late request error'))

      sinon.assert.calledOnceWithExactly(exported, { code: 0 })
      sinon.assert.calledOnceWithExactly(flushed, undefined)
    })

    for (const failure of ['request', 'write', 'end']) {
      it(`reports synchronous ${failure} errors and releases the tracked request`, () => {
        const exported = sinon.spy()
        const flushed = sinon.spy()
        const error = new Error(`${failure} failed`)
        const fail = () => {
          exporter.flush(flushed)
          sinon.assert.notCalled(flushed)
          throw error
        }
        if (failure === 'request') {
          requestStub.callsFake(fail)
        } else {
          requestStub.callsFake(() => {
            const request = new EventEmitter()
            request.write = () => {}
            request.end = () => {}
            request[failure] = fail
            return request
          })
        }

        exporter.sendPayload('{}', exported)

        sinon.assert.calledOnceWithExactly(exported, { code: 1, error })
        sinon.assert.calledOnceWithExactly(flushed, error)
        const nextFlush = sinon.spy()
        exporter.flush(nextFlush)
        sinon.assert.calledOnceWithExactly(nextFlush)
      })
    }

    it('normalizes synchronous non-Error exceptions', () => {
      const exported = sinon.spy()
      const flushed = sinon.spy()
      requestStub.callsFake(() => {
        exporter.flush(flushed)
        // eslint-disable-next-line no-throw-literal
        throw 'request failed'
      })

      exporter.sendPayload('{}', exported)

      const error = exported.firstCall.args[0].error
      assert.ok(error instanceof Error)
      assert.strictEqual(error.message, 'request failed')
      sinon.assert.calledOnceWithExactly(flushed, error)
    })

    it('releases the request even when the per-export callback throws', () => {
      const error = new Error('callback failed')
      const flushed = sinon.spy()
      exporter.sendPayload('{}', () => { throw error })
      exporter.flush(flushed)

      assert.throws(() => respond().emit('end'), error)

      sinon.assert.calledOnceWithExactly(flushed, undefined)
      const nextFlush = sinon.spy()
      exporter.flush(nextFlush)
      sinon.assert.calledOnceWithExactly(nextFlush)
    })

    it('removes completed requests before calling reentrant flush callbacks', () => {
      const nestedFlush = sinon.spy()
      exporter.sendPayload('{}', sinon.spy())
      exporter.flush(() => {
        exporter.flush(nestedFlush)
        sinon.assert.calledOnceWithExactly(nestedFlush)
      })

      respond().emit('end')

      sinon.assert.calledOnce(nestedFlush)
    })
  })

  describe('setUrl', () => {
    it('picks up a proxy agent when re-targeted to an HTTPS endpoint', () => {
      const exporter = new OtlpHttpExporterBase(
        'http://intake.example/path', undefined, 1000, 'http/protobuf', 'traces'
      )
      assert.strictEqual(exporter.options.agent, undefined)

      process.env.https_proxy = 'http://127.0.0.1:9999'
      exporter.setUrl('https://intake.example/other-path')

      assert.ok(exporter.options.agent)
      assert.strictEqual(exporter.options.agent.proxy.hostname, '127.0.0.1')
      assert.strictEqual(exporter.options.agent.proxy.port, '9999')
    })

    it('clears the agent when re-targeted from HTTPS to HTTP', () => {
      process.env.https_proxy = 'http://127.0.0.1:9999'
      const exporter = new OtlpHttpExporterBase(
        'https://intake.example/path', undefined, 1000, 'http/protobuf', 'traces'
      )
      assert.ok(exporter.options.agent)

      exporter.setUrl('http://intake.example/other-path')

      assert.strictEqual(exporter.options.agent, undefined)
    })

    for (const url of ['not a URL', 'ftp://intake.example/other-path']) {
      it(`keeps the current target when re-targeted to ${url}`, () => {
        const exporter = new OtlpHttpExporterBase(
          'http://intake.example/path', undefined, 1000, 'http/protobuf', 'traces'
        )
        const error = sinon.stub(log, 'error')

        exporter.setUrl(url)

        assert.strictEqual(exporter.options.hostname, 'intake.example')
        assert.strictEqual(exporter.options.port, '')
        assert.strictEqual(exporter.options.path, '/path')
        assert.strictEqual(exporter.options.agent, undefined)
        assert.strictEqual(exporter.telemetryTags[0], 'protocol:http')
        sinon.assert.calledOnce(error)
      })
    }

    it('keeps the current target when proxy configuration is invalid', () => {
      const exporter = new OtlpHttpExporterBase(
        'http://intake.example/path', undefined, 1000, 'http/protobuf', 'traces'
      )
      const error = sinon.stub(log, 'error')
      process.env.HTTPS_PROXY = '://invalid'

      exporter.setUrl('https://other.example/other-path')

      assert.strictEqual(exporter.options.hostname, 'intake.example')
      assert.strictEqual(exporter.options.path, '/path')
      assert.strictEqual(exporter.options.agent, undefined)
      assert.strictEqual(exporter.telemetryTags[0], 'protocol:http')
      sinon.assert.calledOnce(error)
    })
  })
})
