'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach } = require('tap').mocha
const { context, propagation, trace, ROOT_CONTEXT } = require('@opentelemetry/api')
const api = require('@opentelemetry/api')

require('../setup/core')

const ContextManager = require('../../src/opentelemetry/context_manager')
const TracerProvider = require('../../src/opentelemetry/tracer_provider')
const tracer = require('../../').init()

function makeSpan (...args) {
  const tracerProvider = new TracerProvider()
  tracerProvider.register()
  const tracer = tracerProvider.getTracer()
  return tracer.startSpan(...args)
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
      }
    }
  })

  it('should create a new context', () => {
    const key1 = api.createContextKey('My first key')
    const key2 = api.createContextKey('My second key')
    expect(key1.description).to.equal('My first key')
    expect(key2.description).to.equal('My second key')
  })

  it('should delete a context', () => {
    const key = api.createContextKey('some key')
    const ctx = api.ROOT_CONTEXT
    const ctx2 = ctx.setValue(key, 'context 2')

    // remove the entry
    const ctx3 = ctx.deleteValue(key)

    expect(ctx3.getValue(key)).to.equal(undefined)
    expect(ctx2.getValue(key)).to.equal('context 2')
    expect(ctx.getValue(key)).to.equal(undefined)
  })

  it('should create a new root context', () => {
    const key = api.createContextKey('some key')
    const ctx = api.ROOT_CONTEXT
    const ctx2 = ctx.setValue(key, 'context 2')
    expect(ctx2.getValue(key)).to.equal('context 2')
    expect(ctx.getValue(key)).to.equal(undefined)
  })

  it('should return root context', () => {
    const ctx = api.context.active()
    expect(ctx).to.be.an.instanceof(ROOT_CONTEXT.constructor)
  })

  it('should set active context', () => {
    const key = api.createContextKey('Key to store a value')
    const ctx = api.context.active()

    api.context.with(ctx.setValue(key, 'context 2'), async () => {
      expect(api.context.active().getValue(key)).to.equal('context 2')
    })
  })

  it('should set active context on an asynchronous callback and return the result synchronously', async () => {
    const name = await api.context.with(api.context.active(), async () => {
      const row = await db.getSomeValue()
      return row.name
    })

    expect(name).to.equal('Dummy Name')
  })

  it('should set active contexts in nested functions', async () => {
    const key = api.createContextKey('Key to store a value')
    const ctx = api.context.active()
    expect(api.context.active().getValue(key)).to.equal(undefined)
    api.context.with(ctx.setValue(key, 'context 2'), () => {
      expect(api.context.active().getValue(key)).to.equal('context 2')
      api.context.with(ctx.setValue(key, 'context 3'), () => {
        expect(api.context.active().getValue(key)).to.equal('context 3')
      })
      expect(api.context.active().getValue(key)).to.equal('context 2')
    })
    expect(api.context.active().getValue(key)).to.equal(undefined)
  })

  it('should not modify contexts, instead it should create new context objects', async () => {
    const key = api.createContextKey('Key to store a value')

    const ctx = api.context.active()

    const ctx2 = ctx.setValue(key, 'context 2')
    expect(ctx.getValue(key)).to.equal(undefined)
    expect(ctx).to.be.an.instanceof(ROOT_CONTEXT.constructor)
    expect(ctx2.getValue(key)).to.equal('context 2')

    const ret = api.context.with(ctx2, () => {
      const ctx3 = api.context.active().setValue(key, 'context 3')

      expect(api.context.active().getValue(key)).to.equal('context 2')
      expect(ctx.getValue(key)).to.equal(undefined)
      expect(ctx2.getValue(key)).to.equal('context 2')
      expect(ctx3.getValue(key)).to.equal('context 3')

      api.context.with(ctx3, () => {
        expect(api.context.active().getValue(key)).to.equal('context 3')
      })
      expect(api.context.active().getValue(key)).to.equal('context 2')

      return 'return value'
    })
    expect(ret).to.equal('return value')
  })

  it('should propagate baggage from an otel span to a datadog span', () => {
    const entries = {
      foo: { value: 'bar' }
    }
    const baggage = propagation.createBaggage(entries)
    const contextWithBaggage = propagation.setBaggage(context.active(), baggage)
    const span = makeSpan('otel-to-dd')
    const contextWithSpan = trace.setSpan(contextWithBaggage, span)
    api.context.with(contextWithSpan, () => {
      expect(tracer.scope().active().getBaggageItem('foo')).to.be.equal('bar')
    })
  })

  it('should propagate baggage from a datadog span to an otel span', () => {
    const baggageKey = 'raccoon'
    const baggageVal = 'chunky'
    const ddSpan = tracer.startSpan('dd-to-otel')
    ddSpan.setBaggageItem(baggageKey, baggageVal)
    tracer.scope().activate(ddSpan, () => {
      const baggages = propagation.getActiveBaggage().getAllEntries()
      expect(baggages.length).to.equal(1)
      const baggage = baggages[0]
      expect(baggage[0]).to.equal(baggageKey)
      expect(baggage[1].value).to.equal(baggageVal)
    })
  })

  it('should handle dd-otel baggage conflict', () => {
    const ddSpan = tracer.startSpan('dd')
    ddSpan.setBaggageItem('key1', 'dd1')
    let contextWithUpdatedBaggages
    tracer.scope().activate(ddSpan, () => {
      let baggages = propagation.getBaggage(api.context.active())
      baggages = baggages.setEntry('key1', { value: 'otel1' })
      baggages = baggages.setEntry('key2', { value: 'otel2' })
      contextWithUpdatedBaggages = propagation.setBaggage(api.context.active(), baggages)
    })
    expect(JSON.parse(ddSpan.getAllBaggageItems())).to.deep.equal({ key1: 'dd1' })
    api.context.with(contextWithUpdatedBaggages, () => {
      expect(JSON.parse(ddSpan.getAllBaggageItems())).to.deep.equal(
        { key1: 'otel1', key2: 'otel2' }
      )
      ddSpan.setBaggageItem('key2', 'dd2')
      expect(propagation.getActiveBaggage().getAllEntries()).to.deep.equal(
        [['key1', { value: 'otel1' }], ['key2', { value: 'dd2' }]]
      )
    })
  })

  it('should handle dd-otel baggage removal', () => {
    const ddSpan = tracer.startSpan('dd')
    ddSpan.setBaggageItem('key1', 'dd1')
    ddSpan.setBaggageItem('key2', 'dd2')
    let contextWithUpdatedBaggages
    tracer.scope().activate(ddSpan, () => {
      let baggages = propagation.getBaggage(api.context.active())
      baggages = baggages.removeEntry('key1')
      contextWithUpdatedBaggages = propagation.setBaggage(api.context.active(), baggages)
    })
    expect(JSON.parse(ddSpan.getAllBaggageItems())).to.deep.equal(
      { key1: 'dd1', key2: 'dd2' }
    )
    api.context.with(contextWithUpdatedBaggages, () => {
      expect(JSON.parse(ddSpan.getAllBaggageItems())).to.deep.equal(
        { key2: 'dd2' }
      )
      ddSpan.removeBaggageItem('key2')
      expect(propagation.getActiveBaggage().getAllEntries()).to.deep.equal([])
    })
  })
})
