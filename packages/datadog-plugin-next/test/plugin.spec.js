'use strict'

const assert = require('node:assert/strict')

const { afterEach, describe, it } = require('mocha')

const { storage } = require('../../datadog-core')

const legacyStorage = storage('legacy')

describe('next plugin', () => {
  afterEach(() => {
    legacyStorage.enterWith(undefined)
    assert.strictEqual(legacyStorage.getStore(), undefined)
  })

  it('emits a Next request span with the extracted Fetch Headers context', () => {
    const tracer = require('../../dd-trace').init({ plugins: false })
    const NextPlugin = require('../src')
    const plugin = new NextPlugin(tracer, {})
    const headers = new Headers({
      'X-Datadog-Trace-Id': '123',
      'X-Datadog-Parent-Id': '456',
    })

    const { span } = plugin.bindStart({ req: { method: 'GET', headers }, res: {} })

    assert.strictEqual(span.context().toTraceId(), '123')
    assert.strictEqual(span.context()._parentId.toString(), '00000000000001c8')
  })

  it('keeps the active local span over conflicting Fetch Headers context', () => {
    const tracer = require('../../dd-trace').init({ plugins: false })
    const NextPlugin = require('../src')
    const plugin = new NextPlugin(tracer, {})
    const localSpan = tracer.startSpan('local.request')
    const headers = new Headers({
      'X-Datadog-Trace-Id': '123',
      'X-Datadog-Parent-Id': '456',
    })

    legacyStorage.run({ span: localSpan }, () => {
      const { span } = plugin.bindStart({ req: { method: 'GET', headers }, res: {} })

      assert.strictEqual(span.context().toTraceId(), localSpan.context().toTraceId())
      assert.strictEqual(span.context()._parentId.toString(), localSpan.context()._spanId.toString())
    })
  })
})
