'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const { context, propagation, trace, ROOT_CONTEXT } = require('@opentelemetry/api')
const api = require('@opentelemetry/api')
const { getAllBaggageItems, setBaggageItem, removeBaggageItem } = require('../../src/baggage')

require('../setup/core')
const ContextManager = require('../../src/opentelemetry/context_manager')
const TracerProvider = require('../../src/opentelemetry/tracer_provider')
require('../../').init()

function getTracer () {
  const tracerProvider = new TracerProvider()
  tracerProvider.register()
  return tracerProvider.getTracer()
}

describe('OTel Context Manager', () => {
  let contextManager
  let db

  beforeEach(() => {
    contextManager = new ContextManager()
    api.context.setGlobalContextManager(contextManager)
    db = {
      getSomeValue: async () => {
        await new Promise(resolve => setTimeout(resolve, 100))
        return { name: 'Dummy Name' }
      },
    }
  })

  it('should create a new context', () => {
    const key1 = api.createContextKey('My first key')
    const key2 = api.createContextKey('My second key')
    assert.strictEqual(key1.description, 'My first key')
    assert.strictEqual(key2.description, 'My second key')
  })

  it('should delete a context', () => {
    const key = api.createContextKey('some key')
    const ctx = api.ROOT_CONTEXT
    const ctx2 = ctx.setValue(key, 'context 2')

    // remove the entry
    const ctx3 = ctx.deleteValue(key)

    assert.strictEqual(ctx3.getValue(key), undefined)
    assert.strictEqual(ctx2.getValue(key), 'context 2')
    assert.strictEqual(ctx.getValue(key), undefined)
  })

  it('should create a new root context', () => {
    const key = api.createContextKey('some key')
    const ctx = api.ROOT_CONTEXT
    const ctx2 = ctx.setValue(key, 'context 2')
    assert.strictEqual(ctx2.getValue(key), 'context 2')
    assert.strictEqual(ctx.getValue(key), undefined)
  })

  it('should return root context', () => {
    const ctx = api.context.active()
    assert.ok(ctx instanceof ROOT_CONTEXT.constructor)
  })

  it('should set active context', () => {
    const key = api.createContextKey('Key to store a value')
    const ctx = api.context.active()

    api.context.with(ctx.setValue(key, 'context 2'), async () => {
      assert.strictEqual(api.context.active().getValue(key), 'context 2')
    })
  })

  it('should set active context on an asynchronous callback and return the result synchronously', async () => {
    const name = await api.context.with(api.context.active(), async () => {
      const row = await db.getSomeValue()
      return row.name
    })

    assert.strictEqual(name, 'Dummy Name')
  })

  it('should set active contexts in nested functions', async () => {
    const key = api.createContextKey('Key to store a value')
    const ctx = api.context.active()
    assert.strictEqual(api.context.active().getValue(key), undefined)
    api.context.with(ctx.setValue(key, 'context 2'), () => {
      assert.strictEqual(api.context.active().getValue(key), 'context 2')
      api.context.with(ctx.setValue(key, 'context 3'), () => {
        assert.strictEqual(api.context.active().getValue(key), 'context 3')
      })
      assert.strictEqual(api.context.active().getValue(key), 'context 2')
    })
    assert.strictEqual(api.context.active().getValue(key), undefined)
  })

  it('should not modify contexts, instead it should create new context objects', async () => {
    const key = api.createContextKey('Key to store a value')

    const ctx = api.context.active()

    const ctx2 = ctx.setValue(key, 'context 2')
    assert.strictEqual(ctx.getValue(key), undefined)
    assert.ok(ctx instanceof ROOT_CONTEXT.constructor)
    assert.strictEqual(ctx2.getValue(key), 'context 2')

    const ret = api.context.with(ctx2, () => {
      const ctx3 = api.context.active().setValue(key, 'context 3')

      assert.strictEqual(api.context.active().getValue(key), 'context 2')
      assert.strictEqual(ctx.getValue(key), undefined)
      assert.strictEqual(ctx2.getValue(key), 'context 2')
      assert.strictEqual(ctx3.getValue(key), 'context 3')

      api.context.with(ctx3, () => {
        assert.strictEqual(api.context.active().getValue(key), 'context 3')
      })
      assert.strictEqual(api.context.active().getValue(key), 'context 2')

      return 'return value'
    })
    assert.strictEqual(ret, 'return value')
  })

  it('should propagate baggage from an otel span to a datadog span', () => {
    const entries = {
      foo: { value: 'bar' },
    }
    const baggage = propagation.createBaggage(entries)
    const contextWithBaggage = propagation.setBaggage(context.active(), baggage)
    api.context.with(contextWithBaggage, () => {
      assert.deepStrictEqual(getAllBaggageItems(), { foo: 'bar' })
    })
  })

  it('should propagate baggage from a datadog span to an otel span', () => {
    setBaggageItem('raccoon', 'chunky')
    assert.deepStrictEqual(propagation.getActiveBaggage().getAllEntries(),
      [['raccoon', { value: 'chunky' }]]
    )
  })

  it('should handle dd-otel baggage conflict', () => {
    setBaggageItem('key1', 'dd1')
    let baggages = propagation.getActiveBaggage()
    baggages = baggages.setEntry('key1', { value: 'otel1' })
    baggages = baggages.setEntry('key2', { value: 'otel2' })
    const contextWithUpdatedBaggages = propagation.setBaggage(context.active(), baggages)
    assert.deepStrictEqual(getAllBaggageItems(), { key1: 'dd1' })
    api.context.with(contextWithUpdatedBaggages, () => {
      assert.deepStrictEqual(getAllBaggageItems(), { key1: 'otel1', key2: 'otel2' })
    })
    setBaggageItem('key2', 'dd2')
    assert.deepStrictEqual(propagation.getActiveBaggage().getAllEntries(),
      [['key1', { value: 'otel1' }], ['key2', { value: 'dd2' }]]
    )
  })

  it('should handle dd-otel baggage removal', () => {
    setBaggageItem('key1', 'dd1')
    setBaggageItem('key2', 'dd2')
    let baggages = propagation.getActiveBaggage()
    baggages = baggages.removeEntry('key1')
    const contextWithUpdatedBaggages = propagation.setBaggage(context.active(), baggages)
    assert.deepStrictEqual(getAllBaggageItems(), { key1: 'dd1', key2: 'dd2' })
    api.context.with(contextWithUpdatedBaggages, () => {
      assert.deepStrictEqual(getAllBaggageItems(), { key2: 'dd2' })
    })
    removeBaggageItem('key2')
    assert.deepStrictEqual(propagation.getActiveBaggage(), undefined)
  })

  it('should return active span', () => {
    const otelTracer = getTracer()
    otelTracer.startActiveSpan('otel', (span) => {
      const activeSpan = trace.getActiveSpan()
      assert.strictEqual(activeSpan, span)
      span.end()
    })
  })
})
