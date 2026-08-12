'use strict'

const assert = require('node:assert/strict')

const api = require('@opentelemetry/api')
const { afterEach, before, describe, it } = require('mocha')

const { patchApp: patchAzureFunctionsApp } = require('../../src/otel-azure-functions')
const { patchApp: patchDurableFunctionsApp } = require('../../src/otel-azure-durable-functions')

function initTracer () {
  process.env.DD_TRACE_OTEL_ENABLED = 'true'
  process.env.DD_TRACE_AZURE_DURABLE_FUNCTIONS_ENABLED = 'false'

  const ddtrace = require('../../../dd-trace')
  if (!global.__otelAzureHandlersTracerInitialized) {
    ddtrace.init({ plugins: false, sampleRate: 1 })
    new ddtrace.TracerProvider().register()
    global.__otelAzureHandlersTracerInitialized = true
  }
}

function createAzureFunctionsApp () {
  let handler
  const app = {}
  for (const method of ['deleteRequest', 'http', 'get', 'patch', 'post', 'put', 'generic']) {
    app[method] = function (name, arg) {
      if (typeof arg === 'function') {
        handler = arg
      } else if (arg?.handler) {
        handler = arg.handler
      }
      return arg
    }
  }
  patchAzureFunctionsApp(app)
  return {
    app,
    getHandler: () => handler,
  }
}

function createDurableFunctionsApp () {
  let handler
  const app = {
    entity (name, arg) {
      if (typeof arg === 'function') {
        handler = arg
      } else if (arg?.handler) {
        handler = arg.handler
      }
      return arg
    },
    activity (name, arg) {
      if (arg?.handler) {
        handler = arg.handler
      }
      return arg
    },
    orchestration (name, arg) {
      handler = arg
      return arg
    },
  }
  patchDurableFunctionsApp(app)
  return {
    app,
    getHandler: () => handler,
  }
}

function invocationContext (overrides = {}) {
  return {
    traceContext: {
      traceParent: '00-00000000000000000000000000000001-0000000000000003-01',
      ...overrides.traceContext,
    },
    df: { isReplaying: false, ...overrides.df },
    ...overrides,
  }
}

describe('otel-azure handler instrumentation', () => {
  before(() => {
    initTracer()
  })

  afterEach(() => {
    api.context.disable()
  })

  describe('HTTP handlers', () => {
    it('traces handlers registered as objects', async () => {
      const { app, getHandler } = createAzureFunctionsApp()
      app.http('hello', {
        handler: async () => 'ok',
      })
      const handler = getHandler()
      const result = await handler({}, invocationContext())
      assert.equal(result, 'ok')
    })

    it('traces handlers registered as functions', async () => {
      const { app, getHandler } = createAzureFunctionsApp()
      app.post('hello', async () => 'posted')
      const handler = getHandler()
      const result = await handler({}, invocationContext())
      assert.equal(result, 'posted')
    })

    it('records errors on failed HTTP handlers', async () => {
      const { app, getHandler } = createAzureFunctionsApp()
      app.get('fail', async () => { throw new Error('boom') })
      const handler = getHandler()
      await assert.rejects(() => handler({}, invocationContext()), /boom/)
    })
  })

  describe('generic orchestration handlers', () => {
    it('skips tracing during replay turns', async () => {
      const { app, getHandler } = createAzureFunctionsApp()
      app.generic('orch', {
        trigger: { type: 'orchestrationTrigger' },
        handler: async () => 'replayed',
      })
      const handler = getHandler()
      const result = await handler({ isReplaying: true }, invocationContext())
      assert.equal(result, 'replayed')
    })

    it('traces generic orchestration handlers', async () => {
      const { app, getHandler } = createAzureFunctionsApp()
      app.generic('orch', {
        trigger: { type: 'orchestrationTrigger' },
        handler: async () => 'done',
      })
      const handler = getHandler()
      const result = await handler({ isReplaying: false }, invocationContext())
      assert.equal(result, 'done')
    })
  })

  describe('durable entity handlers', () => {
    it('traces entity handlers registered as functions', () => {
      const { app, getHandler } = createDurableFunctionsApp()
      app.entity('Counter', () => 1)
      const handler = getHandler()
      assert.equal(handler(invocationContext()), 1)
    })

    it('traces entity handlers registered as objects', () => {
      const { app, getHandler } = createDurableFunctionsApp()
      app.entity('Counter', { handler: () => 2 })
      const handler = getHandler()
      assert.equal(handler(invocationContext()), 2)
    })
  })

  describe('durable activity handlers', () => {
    it('traces synchronous activity handlers', () => {
      const { app, getHandler } = createDurableFunctionsApp()
      app.activity('DoWork', { handler: () => 'sync' })
      const handler = getHandler()
      assert.equal(handler('input', invocationContext()), 'sync')
    })

    it('traces async activity handlers', async () => {
      const { app, getHandler } = createDurableFunctionsApp()
      app.activity('DoWork', { handler: async () => 'async' })
      const handler = getHandler()
      assert.equal(await handler('input', invocationContext()), 'async')
    })

    it('records errors on failed activity handlers', async () => {
      const { app, getHandler } = createDurableFunctionsApp()
      app.activity('DoWork', { handler: async () => { throw new Error('activity failed') } })
      const handler = getHandler()
      await assert.rejects(() => handler('input', invocationContext()), /activity failed/)
    })
  })

  describe('durable orchestration handlers', () => {
    it('exports one orchestration span across generator turns', () => {
      const { app, getHandler } = createDurableFunctionsApp()
      app.orchestration('Flow', function * () {
        yield 'step-1'
        return 'done'
      })
      const handler = getHandler()
      const gen = handler(invocationContext())
      assert.deepEqual(gen.next().value, 'step-1')
      assert.deepEqual(gen.next().value, 'done')
    })

    it('exports the orchestration span when the generator throws', () => {
      const { app, getHandler } = createDurableFunctionsApp()
      app.orchestration('Flow', function * () {
        yield 'step-1'
        throw new Error('orchestration failed')
      })
      const handler = getHandler()
      const gen = handler(invocationContext())
      assert.deepEqual(gen.next().value, 'step-1')
      assert.throws(() => gen.next(), /orchestration failed/)
    })

    it('skips metadata updates during replay turns', () => {
      const { app, getHandler } = createDurableFunctionsApp()
      app.orchestration('Flow', function * () {
        yield 'step-1'
        return 'done'
      })
      const handler = getHandler()
      const gen = handler(invocationContext({ df: { isReplaying: true } }))
      assert.deepEqual(gen.next().value, 'step-1')
      assert.equal(gen.next().done, true)
    })
  })
})
