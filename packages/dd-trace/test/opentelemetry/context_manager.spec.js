'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const { context, propagation, trace, ROOT_CONTEXT } = require('@opentelemetry/api')
const api = require('@opentelemetry/api')
const { assertObjectContains, ANY_STRING } = require('../../../../integration-tests/helpers')
const { getAllBaggageItems, removeAllBaggageItems, removeBaggageItem, setBaggageItem } = require('../../src/baggage')

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

  it('should clear dd baggage when entering an otel context with no baggage', () => {
    removeAllBaggageItems()
    setBaggageItem('outer', 'value')
    assert.deepStrictEqual(getAllBaggageItems(), { outer: 'value' })
    api.context.with(ROOT_CONTEXT, () => {
      assert.deepStrictEqual(getAllBaggageItems(), {})
    })
  })

  it('should silently drop otel baggage that targets Object.prototype.__proto__', () => {
    const entries = { foo: { value: 'bar' } }
    Object.defineProperty(entries, '__proto__', {
      value: { value: 'poison' }, writable: true, enumerable: true, configurable: true,
    })
    const baggage = propagation.createBaggage(entries)
    const contextWithBaggage = propagation.setBaggage(context.active(), baggage)
    api.context.with(contextWithBaggage, () => {
      const baggageItems = getAllBaggageItems()
      assert.strictEqual(Object.getOwnPropertyDescriptor(baggageItems, '__proto__'), undefined)
      assert.strictEqual(Object.getPrototypeOf(baggageItems), Object.prototype)
      assert.deepStrictEqual({ ...baggageItems }, { foo: 'bar' })
    })
  })

  it('should return active span', () => {
    const otelTracer = getTracer()
    otelTracer.startActiveSpan('otel', (span) => {
      const activeSpan = trace.getActiveSpan()
      assert.strictEqual(activeSpan, span)
      span.end()
    })
  })

  describe('with an active Datadog span', () => {
    const ddTracer = require('../../')

    it('exposes the active span via trace.getActiveSpan() and forwards writes', () => {
      ddTracer.trace('dd-active', (ddSpan) => {
        const active = trace.getActiveSpan()
        assert.ok(active)
        assert.strictEqual(active.isRecording(), true)

        active.setAttribute('my.otel.attr', 'ok')
        active.setAttributes({ 'my.otel.attrs': 'ok2' })

        active.addLink({
          context: {
            traceId: '0123456789abcdef0123456789abcdef',
            spanId: '0123456789abcdef',
            traceFlags: 1,
          },
          attributes: { foo: 'bar' },
        })

        active.setStatus({ code: 2, message: 'status boom' })

        assert.strictEqual(ddSpan._links.length, 1)
        assert.deepStrictEqual({
          tags: {
            'my.otel.attr': ddSpan.context()._tags['my.otel.attr'],
            'my.otel.attrs': ddSpan.context()._tags['my.otel.attrs'],
            'error.message': ddSpan.context()._tags['error.message'],
          },
          link: {
            traceId: ddSpan._links[0].context.toTraceId(true),
            spanId: ddSpan._links[0].context.toSpanId(true),
            attributes: ddSpan._links[0].attributes,
          },
        }, {
          tags: {
            'my.otel.attr': 'ok',
            'my.otel.attrs': 'ok2',
            'error.message': 'status boom',
          },
          link: {
            traceId: '0123456789abcdef0123456789abcdef',
            spanId: '0123456789abcdef',
            attributes: { foo: 'bar' },
          },
        })

        active.recordException(new Error('boom'))
        assert.strictEqual(ddSpan.context()._tags['error.message'], 'boom')
      })
    })

    it('addEvent normalizes OTel time/attribute inputs onto the Datadog span', () => {
      ddTracer.trace('dd-active', (ddSpan) => {
        const active = trace.getActiveSpan()
        assert.ok(active)

        const hrTime = /** @type {[number, number]} */ ([1700000000, 500000000])
        const hrTimeMs = hrTime[0] * 1e3 + hrTime[1] / 1e6
        const date = new Date(1700000000000)

        active.addEvent('with-hr-time', hrTime)
        active.addEvent('with-date', date)
        active.addEvent('with-attrs-and-hr-time', { code: 42 }, hrTime)

        // Single equality guards: no array-indexed attribute leak on the time-only forms,
        // numeric startTime (not hrTime array) so span_format's Math.round(startTime * 1e6)
        // cannot produce NaN.
        assert.deepStrictEqual(ddSpan._events, [
          { name: 'with-hr-time', startTime: hrTimeMs },
          { name: 'with-date', startTime: date.getTime() },
          { name: 'with-attrs-and-hr-time', attributes: { code: 42 }, startTime: hrTimeMs },
        ])
      })
    })

    it('recordException forwards a user-supplied hrTime timestamp as ms', () => {
      ddTracer.trace('dd-active', (ddSpan) => {
        const active = trace.getActiveSpan()
        assert.ok(active)

        const hrTime = /** @type {[number, number]} */ ([1700000500, 250000000])
        const hrTimeMs = hrTime[0] * 1e3 + hrTime[1] / 1e6

        active.recordException(new Error('boom'), hrTime)

        assertObjectContains(ddSpan._events.at(-1), {
          name: 'Error',
          startTime: hrTimeMs,
          attributes: {
            'exception.message': 'boom',
            'exception.stacktrace': ANY_STRING,
          },
        })
      })
    })

    it('end() on the proxy does not finish the Datadog span', () => {
      ddTracer.trace('dd-active', (ddSpan) => {
        const active = trace.getActiveSpan()
        active.end()
        assert.strictEqual(ddSpan._duration, undefined)
      })
    })

    it('addLinks forwards every valid link and skips invalid contexts', () => {
      ddTracer.trace('dd-active', (ddSpan) => {
        const active = trace.getActiveSpan()

        active.addLinks([
          {
            context: {
              traceId: '0123456789abcdef0123456789abcdef',
              spanId: '0123456789abcdef',
              traceFlags: 1,
            },
            attributes: { tag: 'first' },
          },
          { context: undefined, attributes: { skipped: 'yes' } },
          {
            context: {
              traceId: 'fedcba9876543210fedcba9876543210',
              spanId: 'fedcba9876543210',
            },
            attributes: { tag: 'second' },
          },
        ])

        assert.strictEqual(ddSpan._links.length, 2)
        assert.deepStrictEqual(
          ddSpan._links.map(({ context, attributes }) => ({
            traceId: context.toTraceId(true),
            spanId: context.toSpanId(true),
            attributes,
          })),
          [
            {
              traceId: '0123456789abcdef0123456789abcdef',
              spanId: '0123456789abcdef',
              attributes: { tag: 'first' },
            },
            {
              traceId: 'fedcba9876543210fedcba9876543210',
              spanId: 'fedcba9876543210',
              attributes: { tag: 'second' },
            },
          ]
        )
      })
    })

    it('addLinks ignores non-array input', () => {
      ddTracer.trace('dd-active', (ddSpan) => {
        const active = trace.getActiveSpan()
        active.addLinks(undefined)
        active.addLinks('not an array')
        assert.strictEqual(ddSpan._links.length, 0)
      })
    })

    it('caches the proxy so repeated calls return the same object', () => {
      ddTracer.trace('dd-active', () => {
        assert.strictEqual(trace.getActiveSpan(), trace.getActiveSpan())
      })
    })

    it('updateName updates resource.name on the DD span, not the operation name', () => {
      ddTracer.trace('dd-active', (ddSpan) => {
        const active = trace.getActiveSpan()
        active.updateName('renamed')

        const ddContext = ddSpan.context()
        assert.strictEqual(ddContext._name, 'dd-active')
        assert.strictEqual(ddContext._tags['resource.name'], 'renamed')
      })
    })

    describe('setStatus precedence (OTel spec)', () => {
      it('OK locks subsequent ERROR and UNSET writes', () => {
        ddTracer.trace('dd-active-ok', (ddSpan) => {
          const active = trace.getActiveSpan()
          active.setStatus({ code: 1 })
          active.setStatus({ code: 2, message: 'late error' })
          active.setStatus({ code: 0, message: 'late unset' })

          assert.ok(!('error.message' in ddSpan.context()._tags))
        })
      })

      it('ERROR can be replaced by a later ERROR with a fresh message', () => {
        ddTracer.trace('dd-active-error', (ddSpan) => {
          const active = trace.getActiveSpan()
          active.setStatus({ code: 2, message: 'first error' })
          active.setStatus({ code: 2, message: 'second error' })

          assert.strictEqual(ddSpan.context()._tags['error.message'], 'second error')
        })
      })
    })

    it('mutation methods are all no-ops once the underlying DD span has finished', () => {
      ddTracer.trace('dd-active', (ddSpan) => {
        const active = trace.getActiveSpan()
        ddSpan.finish()

        active.setAttribute('after.end', 'no')
        active.setAttributes({ 'after.end.batch': 'no' })
        active.addLink({
          context: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 },
        })
        active.addLinks([{ context: { traceId: 'c'.repeat(32), spanId: 'd'.repeat(16) } }])
        active.addEvent('after.end.event')
        active.recordException(new Error('after end'))
        active.setStatus({ code: 2, message: 'after end' })
        active.updateName('after end')

        assert.deepStrictEqual(ddSpan.context()._tags, {})
        assert.strictEqual(ddSpan._links.length, 0)
        assert.strictEqual(ddSpan._events.length, 0)
      })
    })
  })
})
