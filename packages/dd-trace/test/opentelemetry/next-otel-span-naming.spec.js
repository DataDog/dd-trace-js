'use strict'

const assert = require('node:assert/strict')

const api = require('@opentelemetry/api')
const { describe, it, beforeEach, afterEach } = require('mocha')

require('../setup/core')

const tracer = require('../../').init()

// Requiring the Next.js instrumentation registers the bridge pre-finish hook that corrects Next's
// own OTel root request span. In OTel-bridge mode Next emits these spans directly, so the
// correction lives in the instrumentation (loaded regardless of `plugins: false`) rather than in
// the bridge, which owns no Next knowledge.
require('../../../datadog-instrumentations/src/next')

const TracerProvider = require('../../src/opentelemetry/tracer_provider')

const NEXT_HANDLE_REQUEST = 'BaseServer.handleRequest'

// Capture the span as the exporter receives it, i.e. after the trace has been
// formatted and is about to be written. The Next root span is the only span in
// its trace, so `Span.end()` -> `_ddSpan.finish()` builds and exports the
// payload synchronously; asserting here proves the correction reached the wire
// rather than a post-finish re-format that no exported trace ever sees.
function captureExportedRootSpan (run) {
  const exporter = tracer._tracer._exporter
  const originalExport = exporter.export
  let exported
  exporter.export = (spans) => {
    exported ??= spans[0]
  }
  try {
    run()
  } finally {
    exporter.export = originalExport
  }
  return exported
}

function startNextRootSpan ({ method = 'GET', initialName } = {}) {
  const provider = new TracerProvider()
  provider.register()
  const otelTracer = provider.getTracer()

  // Mirror how Next creates the root request span: the initial span name is the
  // bare HTTP method, and `next.span_type` / `next.span_name` are start attributes.
  return otelTracer.startSpan(initialName ?? method, {
    kind: api.SpanKind.SERVER,
    attributes: {
      'next.span_type': NEXT_HANDLE_REQUEST,
      'next.span_name': method,
      'http.method': method,
      'http.target': '/',
    },
  })
}

function finishNextRootSpan (span, { method, route, rsc = false } = {}) {
  // Next sets the resolved name on `next.span_name`, then calls `updateName`,
  // then `end()`. `updateName` routes through the OTel-default operation-name
  // semantics, which is the behaviour the correction has to fix on finish.
  if (route) {
    const name = rsc ? `RSC ${method} ${route}` : `${method} ${route}`
    span.setAttributes({
      'next.route': route,
      'http.route': route,
      'next.span_name': name,
    })
    span.updateName(name)
  } else {
    const name = rsc ? `RSC ${method}` : `${method}`
    span.setAttributes({ 'next.span_name': name })
    span.updateName(name)
  }
  span.end()
}

describe('Next.js OTel bridge span naming', () => {
  it('rewrites a routed Next root request span to next.request + "GET /route" resource', () => {
    const exported = captureExportedRootSpan(() => {
      finishNextRootSpan(startNextRootSpan({ method: 'GET' }), { method: 'GET', route: '/products/[slug]' })
    })
    assert.strictEqual(exported.name, 'next.request')
    assert.strictEqual(exported.resource, 'GET /products/[slug]')
  })

  it('keeps the resource as the bare method when there is no route (404)', () => {
    const exported = captureExportedRootSpan(() => {
      finishNextRootSpan(startNextRootSpan({ method: 'GET' }), { method: 'GET' })
    })
    assert.strictEqual(exported.name, 'next.request')
    assert.strictEqual(exported.resource, 'GET')
  })

  it('mirrors Next RSC naming in the resource', () => {
    const exported = captureExportedRootSpan(() => {
      finishNextRootSpan(startNextRootSpan({ method: 'GET' }), { method: 'GET', route: '/products/[slug]', rsc: true })
    })
    assert.strictEqual(exported.name, 'next.request')
    assert.strictEqual(exported.resource, 'RSC GET /products/[slug]')
  })

  it('uses the http.method tag with a non-GET verb', () => {
    const exported = captureExportedRootSpan(() => {
      finishNextRootSpan(startNextRootSpan({ method: 'POST' }), { method: 'POST', route: '/api/login' })
    })
    assert.strictEqual(exported.name, 'next.request')
    assert.strictEqual(exported.resource, 'POST /api/login')
  })

  it('leaves a non-Next OTel span untouched', () => {
    const exported = captureExportedRootSpan(() => {
      const provider = new TracerProvider()
      provider.register()
      const span = provider.getTracer().startSpan('GET', {
        kind: api.SpanKind.SERVER,
        attributes: { 'http.method': 'GET' },
      })
      span.updateName('GET /products/[slug]')
      span.end()
    })
    // The generic bridge behaviour: updateName drives the operation name and the
    // resource keeps the original span name.
    assert.strictEqual(exported.name, 'GET /products/[slug]')
    assert.strictEqual(exported.resource, 'GET')
  })

  describe('when next.span_name is absent', () => {
    // A Next build that marks the root span and sets the route tags but never writes
    // `next.span_name` still has to yield the route-bearing resource the issue describes.
    // The span is started without `next.span_name` to model that shape through startSpan.
    function startWithoutSpanName (method = 'GET') {
      const provider = new TracerProvider()
      provider.register()
      return provider.getTracer().startSpan(method, {
        kind: api.SpanKind.SERVER,
        attributes: { 'next.span_type': NEXT_HANDLE_REQUEST, 'http.method': method },
      })
    }

    it('constructs the resource from http.method and next.route', () => {
      const exported = captureExportedRootSpan(() => {
        const span = startWithoutSpanName('GET')
        span.setAttributes({ 'next.route': '/products/[slug]', 'http.route': '/products/[slug]' })
        span.updateName('GET /products/[slug]')
        span.end()
      })
      assert.strictEqual(exported.name, 'next.request')
      assert.strictEqual(exported.resource, 'GET /products/[slug]')
    })

    it('falls back to http.route when next.route is absent', () => {
      const exported = captureExportedRootSpan(() => {
        const span = startWithoutSpanName('GET')
        span.setAttributes({ 'http.route': '/api/health' })
        span.updateName('GET /api/health')
        span.end()
      })
      assert.strictEqual(exported.name, 'next.request')
      assert.strictEqual(exported.resource, 'GET /api/health')
    })

    it('constructs the bare method when there is no route', () => {
      const exported = captureExportedRootSpan(() => {
        const span = startWithoutSpanName('GET')
        span.updateName('GET')
        span.end()
      })
      assert.strictEqual(exported.name, 'next.request')
      assert.strictEqual(exported.resource, 'GET')
    })
  })

  describe('with the v1 span attribute schema', () => {
    let previousConfig

    beforeEach(() => {
      previousConfig = tracer._nomenclature.config
      tracer._nomenclature.configure({ ...previousConfig, spanAttributeSchema: 'v1' })
    })

    afterEach(() => {
      tracer._nomenclature.configure(previousConfig)
    })

    it('resolves the operation name to http.server.request', () => {
      const exported = captureExportedRootSpan(() => {
        finishNextRootSpan(startNextRootSpan({ method: 'GET' }), { method: 'GET', route: '/products/[slug]' })
      })
      assert.strictEqual(exported.name, 'http.server.request')
      assert.strictEqual(exported.resource, 'GET /products/[slug]')
    })
  })
})
