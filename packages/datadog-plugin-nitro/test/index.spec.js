'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('../../dd-trace/test/setup/core')

const tags = require('../../../ext/tags')
const DatadogSpanContext = require('../../dd-trace/src/opentracing/span_context')
const NitroPlugin = require('../src')

function makeSpan (spanTags) {
  const context = new DatadogSpanContext({
    tags: { ...spanTags },
    trace: {
      started: [],
      finished: [],
      tags: {},
      isRecording: true,
    },
  })

  return {
    _spanContext: context,
    context () {
      return context
    },
    setTag (key, value) {
      context.setTag(key, value)
    },
    addTags (newTags) {
      Object.assign(context.getTags(), newTags)
    },
    finish () {
      context._isFinished = true
    },
  }
}

function makePlugin (config) {
  const spans = []
  const tracer = {
    _service: 'test',
    _nomenclature: {
      opName () {
        return 'nitro.server.request'
      },
      serviceName () {
        return 'test'
      },
    },
    extract () {},
    startSpan (_name, options) {
      const span = makeSpan(options.tags)
      spans.push(span)
      return span
    },
  }
  const plugin = new NitroPlugin(tracer, {})

  plugin.configure({ enabled: false, ...config })

  return { plugin, spans }
}

function makeContext (url, headers = {}) {
  const req = new Request(url, { headers })

  return {
    type: 'request',
    event: {
      req,
      context: {},
    },
  }
}

describe('NitroPlugin', () => {
  it('applies HttpServer filter drops at span start', () => {
    const { plugin, spans } = makePlugin({
      filter: url => !url.includes('/drop'),
    })
    const ctx = makeContext('http://example.com/drop?password=secret')

    plugin.bindStart(ctx)

    const spanContext = spans[0].context()
    assert.strictEqual(spanContext.getTag(tags.MANUAL_DROP), true)
    assert.strictEqual(spanContext._trace.isRecording, false)
  })

  it('uses web finish behavior for query obfuscation, configured headers, route, and resource tags', () => {
    const { plugin, spans } = makePlugin({
      headers: ['x-secret', 'x-response'],
    })
    const ctx = makeContext('http://example.com/allowed?password=secret&foo=bar', {
      'x-secret': 'request-secret',
    })

    plugin.bindStart(ctx)
    ctx.event.context.matchedRoute = { route: '/allowed' }
    ctx.result = new Response('ok', {
      status: 200,
      headers: {
        'x-response': 'response-secret',
      },
    })
    plugin.end(ctx)

    const spanContext = spans[0].context()
    const spanTags = spanContext.getTags()

    assert.strictEqual(spanTags[tags.HTTP_URL], 'http://example.com/allowed')
    assert.strictEqual(spanTags[tags.HTTP_ROUTE], '/allowed')
    assert.strictEqual(spanTags[tags.RESOURCE_NAME], 'GET /allowed')
    assert.strictEqual(spanTags[`${tags.HTTP_REQUEST_HEADERS}.x-secret`], 'request-secret')
    assert.strictEqual(spanTags[`${tags.HTTP_RESPONSE_HEADERS}.x-response`], 'response-secret')
    assert.strictEqual(spanContext._isFinished, true)
  })
})
