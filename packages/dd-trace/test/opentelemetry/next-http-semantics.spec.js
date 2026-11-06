'use strict'

const assert = require('node:assert/strict')

const api = require('@opentelemetry/api')
const { afterEach, before, describe, it } = require('mocha')
const sinon = require('sinon')

require('../setup/core')

const tracer = require('../../')
let provider

describe('Next.js native OTel HTTP semantics', () => {
  before(() => {
    const previous = process.env.DD_TRACE_OTEL_SEMANTICS_ENABLED
    process.env.DD_TRACE_OTEL_SEMANTICS_ENABLED = 'true'
    tracer.init({ plugins: false })
    if (previous === undefined) {
      delete process.env.DD_TRACE_OTEL_SEMANTICS_ENABLED
    } else {
      process.env.DD_TRACE_OTEL_SEMANTICS_ENABLED = previous
    }
    provider = new tracer.TracerProvider()
    require('../../../datadog-instrumentations/src/next')
  })

  afterEach(() => {
    sinon.restore()
  })

  for (const method of ['GET', 'PROPFIND']) {
    for (const route of [undefined, '/api/test']) {
      it(`normalizes ${method} with route ${route}`, () => {
        const span = exportNextSpan(method, 200, route)
        const resource = method === 'GET' ? 'GET' : 'HTTP'

        assert.strictEqual(span.resource, route ? `${resource} ${route}` : resource)
        assert.strictEqual(span.meta['http.request.method'], method === 'GET' ? 'GET' : '_OTHER')
      })
    }
  }

  for (const status of [200, 499, 500, 599, 600]) {
    it(`classifies a native response with status ${status}`, () => {
      const span = exportNextSpan('GET', status, '/api/test')

      assert.strictEqual(span.meta['_dd.otel.status_error'], undefined)
      assert.strictEqual(span.meta['_dd.otel.instrumentation_http_resource'], undefined)
      assert.strictEqual(span.error, status >= 500 ? 1 : 0)
      assert.strictEqual(span.meta['error.type'], status >= 500 ? String(status) : undefined)
    })
  }

  for (const status of [400, 503]) {
    it(`preserves an exception type with status ${status}`, () => {
      const span = exportNextSpan('GET', status, '/api/test', new TypeError('handler failed'))

      assert.strictEqual(span.error, 1)
      assert.strictEqual(span.meta['error.type'], 'TypeError')
    })
  }

  for (const nativeErrorStatus of [false, true]) {
    for (const status of [499, 500, 600]) {
      it(`preserves explicit OK with status ${status} and native error status ${nativeErrorStatus}`, () => {
        const span = exportNextSpan('GET', status, '/api/test', undefined, api.SpanStatusCode.OK, nativeErrorStatus)

        assert.strictEqual(span.error, 0)
        assert.strictEqual(span.meta['error.type'], nativeErrorStatus && status >= 500 ? String(status) : undefined)
        assert.strictEqual(span.meta['_dd.otel.status_error'], undefined)
      })
    }
  }
})

/**
 * @param {string} method
 * @param {number} status
 * @param {string} [route]
 * @param {Error} [error]
 * @param {import('@opentelemetry/api').SpanStatusCode} [statusCode]
 * @param {boolean} [nativeErrorStatus]
 */
function exportNextSpan (method, status, route, error, statusCode, nativeErrorStatus) {
  const exporter = sinon.stub(tracer._tracer._exporter, 'export')
  const span = provider.getTracer('next').startSpan(method, {
    kind: api.SpanKind.SERVER,
    attributes: {
      'next.span_type': 'BaseServer.handleRequest',
      'next.span_name': method,
      'http.method': method,
    },
  })
  const name = route ? `${method} ${route}` : method
  if (statusCode !== undefined) span.setStatus({ code: statusCode })
  span.setAttributes({
    'http.status_code': status,
    'next.route': route,
    'http.route': route,
    'next.span_name': name,
  })
  if (nativeErrorStatus && status >= 500) {
    span.setStatus({ code: api.SpanStatusCode.ERROR })
    span.setAttribute('error.type', String(status))
  }
  span.updateName(name)
  if (error) {
    span.recordException(error)
    span.setAttribute('error.type', error.name)
    span.setStatus({ code: api.SpanStatusCode.ERROR, message: error.message })
  }
  span.end()

  sinon.assert.calledOnce(exporter)
  return exporter.firstCall.args[0][0]
}
