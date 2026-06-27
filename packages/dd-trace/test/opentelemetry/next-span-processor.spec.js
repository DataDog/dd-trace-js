'use strict'

const assert = require('node:assert/strict')

const api = require('@opentelemetry/api')
const { describe, it, beforeEach, afterEach } = require('mocha')

require('../setup/core')

const tracer = require('../../').init()

const TracerProvider = require('../../src/opentelemetry/tracer_provider')
const spanFormat = require('../../src/span_format')

const NEXT_HANDLE_REQUEST = 'BaseServer.handleRequest'

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
  // semantics, which is the behaviour the processor has to correct on finish.
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

describe('OTel Next.js span processor', () => {
  it('rewrites a routed Next root request span to next.request + "GET /route" resource', () => {
    const span = startNextRootSpan({ method: 'GET' })
    finishNextRootSpan(span, { method: 'GET', route: '/products/[slug]' })

    const formatted = spanFormat(span._ddSpan)
    assert.strictEqual(formatted.name, 'next.request')
    assert.strictEqual(formatted.resource, 'GET /products/[slug]')
  })

  it('keeps the resource as the bare method when there is no route (404)', () => {
    const span = startNextRootSpan({ method: 'GET' })
    finishNextRootSpan(span, { method: 'GET' })

    const formatted = spanFormat(span._ddSpan)
    assert.strictEqual(formatted.name, 'next.request')
    assert.strictEqual(formatted.resource, 'GET')
  })

  it('mirrors Next RSC naming in the resource', () => {
    const span = startNextRootSpan({ method: 'GET' })
    finishNextRootSpan(span, { method: 'GET', route: '/products/[slug]', rsc: true })

    const formatted = spanFormat(span._ddSpan)
    assert.strictEqual(formatted.name, 'next.request')
    assert.strictEqual(formatted.resource, 'RSC GET /products/[slug]')
  })

  it('uses the http.method tag with a non-GET verb', () => {
    const span = startNextRootSpan({ method: 'POST' })
    finishNextRootSpan(span, { method: 'POST', route: '/api/login' })

    const formatted = spanFormat(span._ddSpan)
    assert.strictEqual(formatted.name, 'next.request')
    assert.strictEqual(formatted.resource, 'POST /api/login')
  })

  it('leaves a non-Next OTel span untouched', () => {
    const provider = new TracerProvider()
    provider.register()
    const otelTracer = provider.getTracer()

    const span = otelTracer.startSpan('GET', {
      kind: api.SpanKind.SERVER,
      attributes: { 'http.method': 'GET' },
    })
    span.updateName('GET /products/[slug]')
    span.end()

    const formatted = spanFormat(span._ddSpan)
    // The generic bridge behaviour: updateName drives the operation name and the
    // resource keeps the original span name.
    assert.strictEqual(formatted.name, 'GET /products/[slug]')
    assert.strictEqual(formatted.resource, 'GET')
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
      const span = startWithoutSpanName('GET')
      span.setAttributes({ 'next.route': '/products/[slug]', 'http.route': '/products/[slug]' })
      span.updateName('GET /products/[slug]')
      span.end()

      const formatted = spanFormat(span._ddSpan)
      assert.strictEqual(formatted.name, 'next.request')
      assert.strictEqual(formatted.resource, 'GET /products/[slug]')
    })

    it('falls back to http.route when next.route is absent', () => {
      const span = startWithoutSpanName('GET')
      span.setAttributes({ 'http.route': '/api/health' })
      span.updateName('GET /api/health')
      span.end()

      const formatted = spanFormat(span._ddSpan)
      assert.strictEqual(formatted.name, 'next.request')
      assert.strictEqual(formatted.resource, 'GET /api/health')
    })

    it('constructs the bare method when there is no route', () => {
      const span = startWithoutSpanName('GET')
      span.updateName('GET')
      span.end()

      const formatted = spanFormat(span._ddSpan)
      assert.strictEqual(formatted.name, 'next.request')
      assert.strictEqual(formatted.resource, 'GET')
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
      const span = startNextRootSpan({ method: 'GET' })
      finishNextRootSpan(span, { method: 'GET', route: '/products/[slug]' })

      const formatted = spanFormat(span._ddSpan)
      assert.strictEqual(formatted.name, 'http.server.request')
      assert.strictEqual(formatted.resource, 'GET /products/[slug]')
    })
  })
})
