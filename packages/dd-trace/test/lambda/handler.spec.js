'use strict'

const assert = require('node:assert/strict')
const { describe, it, before, after } = require('mocha')
const dc = require('dc-polyfill')

require('../../src/lambda/handler')

const startInvocationChannel = dc.channel('datadog:lambda:start-invocation')

describe('lambda/handler — header tags', () => {
  let originalDdtrace

  before(() => {
    originalDdtrace = global._ddtrace
    global._ddtrace = { _tracer: { _config: { headerTags: ['host', 'user-agent:http.useragent', 'x-request-id'] } } }
  })

  after(() => {
    global._ddtrace = originalDdtrace
  })

  function makeSpan () {
    const tags = {}
    return {
      setTag (k, v) { tags[k] = v },
      getTags () { return { ...tags } },
    }
  }

  it('should tag a plain header name with the default tag name', () => {
    const span = makeSpan()
    startInvocationChannel.publish({ span, headers: { host: 'example.com' } })
    assert.deepStrictEqual(span.getTags(), { 'http.request.headers.host': 'example.com' })
  })

  it('should tag a header with a custom tag name', () => {
    const span = makeSpan()
    startInvocationChannel.publish({ span, headers: { 'user-agent': 'test-agent/1.0' } })
    assert.deepStrictEqual(span.getTags(), { 'http.useragent': 'test-agent/1.0' })
  })

  it('should tag multiple configured headers at once', () => {
    const span = makeSpan()
    startInvocationChannel.publish({ span, headers: { host: 'example.com', 'user-agent': 'test-agent/1.0' } })
    assert.deepStrictEqual(span.getTags(), {
      'http.request.headers.host': 'example.com',
      'http.useragent': 'test-agent/1.0',
    })
  })

  it('should skip headers not present in the event', () => {
    const span = makeSpan()
    startInvocationChannel.publish({ span, headers: { host: 'example.com' } })
    assert.strictEqual(span.getTags()['http.request.headers.x-request-id'], undefined)
  })

  it('should do nothing when span is falsy', () => {
    startInvocationChannel.publish({ span: null, headers: { host: 'example.com' } })
  })

  it('should do nothing when headers are falsy', () => {
    const span = makeSpan()
    startInvocationChannel.publish({ span, headers: null })
    assert.deepStrictEqual(span.getTags(), {})
  })
})
