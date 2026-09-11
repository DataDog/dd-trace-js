'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, before, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const azureDurableFunctionsChannel = dc.tracingChannel('datadog:azure:durable-functions:invoke')

describe('azure-functions orchestration instrumentation (unit)', () => {
  let azureFunctionsHook
  const subscriptions = []

  before(() => {
    const realInstrument = require('../src/helpers/instrument')
    const addHookSpy = sinon.spy()
    proxyquire('../src/azure-functions', {
      './helpers/instrument': { ...realInstrument, addHook: addHookSpy },
    })
    const call = addHookSpy.getCalls().find(c => c.args[0].name === '@azure/functions')
    azureFunctionsHook = call.args[1]
  })

  function subscribeStart (listener) {
    azureDurableFunctionsChannel.start.subscribe(listener)
    subscriptions.push([azureDurableFunctionsChannel.start, listener])
  }

  afterEach(() => {
    while (subscriptions.length > 0) {
      const [channel, listener] = subscriptions.pop()
      channel.unsubscribe(listener)
    }
  })

  function registerOrchestration (handler) {
    const app = {
      generic (name, options) {
        this.registered = { name, options }
      },
      deleteRequest () {},
      http () {},
      get () {},
      patch () {},
      post () {},
      put () {},
      serviceBusQueue () {},
      serviceBusTopic () {},
      eventHub () {},
      cosmosDB () {},
    }

    azureFunctionsHook({ app })

    const options = {
      trigger: { type: 'orchestrationTrigger' },
      handler,
    }
    app.generic('PizzaOrderOrchestration', options)
    return options.handler
  }

  it('publishes an Orchestration span context for durable invocations', async () => {
    let started
    subscribeStart((ctx) => { started = ctx })

    const wrapped = registerOrchestration(async () => 'ok')
    const binding = { isReplaying: false }
    const invocationContext = {
      traceContext: {
        traceParent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        traceState: 'dd=s:1',
      },
    }

    await wrapped(binding, invocationContext)

    assert.strictEqual(started.trigger, 'Orchestration')
    assert.strictEqual(started.functionName, 'PizzaOrderOrchestration')
    assert.strictEqual(
      started.traceparent,
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    )
    assert.strictEqual(started.tracestate, 'dd=s:1')
  })

  it('skips tracing when the orchestrator has a previous activation', async () => {
    let started = false
    subscribeStart(() => { started = true })

    const result = Promise.resolve('ok')
    const wrapped = registerOrchestration(() => result)
    const binding = {
      isReplaying: false,
      history: [{ EventType: 13 }],
    }

    const returned = wrapped(binding, {})
    await returned

    assert.strictEqual(started, false)
    assert.strictEqual(returned, result)
  })

  it('does not wrap non-orchestration generic triggers', async () => {
    subscribeStart(() => {})

    const app = {
      generic (name, options) {
        this.registered = { name, options }
      },
      deleteRequest () {},
      http () {},
      get () {},
      patch () {},
      post () {},
      put () {},
      serviceBusQueue () {},
      serviceBusTopic () {},
      eventHub () {},
      cosmosDB () {},
    }

    azureFunctionsHook({ app })

    const handler = async () => 'ok'
    const options = {
      trigger: { type: 'activityTrigger' },
      handler,
    }
    app.generic('PreparePizzaActivity', options)

    assert.strictEqual(options.handler, handler)
  })

  it('invokes the handler when there are no channel subscribers', async () => {
    const handler = sinon.spy(async () => 'done')
    const wrapped = registerOrchestration(handler)

    const result = await wrapped({ isReplaying: false }, {})

    assert.strictEqual(result, 'done')
    sinon.assert.calledOnce(handler)
  })
})
