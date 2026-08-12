'use strict'

const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')

const api = require('@opentelemetry/api')
const { afterEach, before, beforeEach, describe, it } = require('mocha')

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

function invocationContext (instanceId, overrides = {}) {
  return {
    traceContext: {
      traceParent: '00-00000000000000000000000000000001-0000000000000003-01',
      attributes: {
        'durabletask.task.instance_id': instanceId,
        ...overrides.attributes,
      },
      ...overrides.traceContext,
    },
    df: { isReplaying: false, ...overrides.df },
    ...overrides,
  }
}

describe('otel-azure handler instrumentation', () => {
  let previousStoreDir

  before(() => {
    initTracer()
  })

  beforeEach(() => {
    previousStoreDir = process.env.DD_TRACE_AZURE_ORCHESTRATION_STORE_DIR
    process.env.DD_TRACE_AZURE_ORCHESTRATION_STORE_DIR = path.join(
      os.tmpdir(),
      `dd-orch-handler-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    )
  })

  afterEach(() => {
    if (previousStoreDir === undefined) {
      delete process.env.DD_TRACE_AZURE_ORCHESTRATION_STORE_DIR
    } else {
      process.env.DD_TRACE_AZURE_ORCHESTRATION_STORE_DIR = previousStoreDir
    }
  })

  describe('HTTP handlers', () => {
    it('traces handlers registered as objects', async () => {
      const { app, getHandler } = createAzureFunctionsApp()

      app.http('StartParty', {
        handler: async () => 'started',
      })

      const result = await getHandler()({}, {
        traceContext: { traceParent: '00-00000000000000000000000000000001-0000000000000004-01' },
      })
      assert.equal(result, 'started')
    })

    it('traces handlers registered as functions', async () => {
      const { app, getHandler } = createAzureFunctionsApp()

      app.post('StartParty', async () => 'posted')

      const result = await getHandler()({}, {
        traceContext: { traceParent: '00-00000000000000000000000000000001-0000000000000004-01' },
      })
      assert.equal(result, 'posted')
    })

    it('records errors on failed HTTP handlers', async () => {
      const { app, getHandler } = createAzureFunctionsApp()

      app.http('FailParty', {
        handler: async () => {
          throw new Error('http failed')
        },
      })

      await assert.rejects(
        () => getHandler()({}, { traceContext: { traceParent: '00-a-b-01' } }),
        /http failed/,
      )
    })
  })

  describe('generic orchestration handlers', () => {
    it('skips tracing during replay turns', async () => {
      const { app, getHandler } = createAzureFunctionsApp()

      app.generic('GenericOrch', {
        trigger: { type: 'orchestrationTrigger' },
        handler: async () => 'replayed',
      })

      const result = await getHandler()(
        { isReplaying: true },
        invocationContext('replay-inst'),
      )
      assert.equal(result, 'replayed')
    })

    it('exports the orchestration span when the runtime reports completion', async () => {
      const { app, getHandler } = createAzureFunctionsApp()

      app.generic('GenericOrch', {
        trigger: { type: 'orchestrationTrigger' },
        handler: async () => 'done',
      })

      const ctx = invocationContext('generic-complete', {
        traceContext: {
          attributes: {
            'durabletask.task.instance_id': 'generic-complete',
            DurableFunctionsRuntimeStatus: 'Completed',
          },
        },
      })

      const result = await getHandler()({ isReplaying: false }, ctx)
      assert.equal(result, 'done')
    })

    it('exports the orchestration span when the handler fails', async () => {
      const { app, getHandler } = createAzureFunctionsApp()

      app.generic('GenericOrch', {
        trigger: { type: 'orchestrationTrigger' },
        handler: async () => {
          throw new Error('generic failed')
        },
      })

      await assert.rejects(
        () => getHandler()({ isReplaying: false }, invocationContext('generic-fail')),
        /generic failed/,
      )
    })
  })

  describe('durable entity handlers', () => {
    it('traces entity handlers registered as functions', () => {
      const { app, getHandler } = createDurableFunctionsApp()

      app.entity('Counter', () => 1)

      assert.equal(getHandler()(invocationContext('entity-fn')), 1)
    })

    it('traces entity handlers registered as objects', () => {
      const { app, getHandler } = createDurableFunctionsApp()

      app.entity('Counter', {
        handler: function increment () {
          return 2
        },
      })

      assert.equal(getHandler()(invocationContext('entity-obj')), 2)
    })
  })

  describe('durable activity handlers', () => {
    it('traces synchronous activity handlers', () => {
      const { app, getHandler } = createDurableFunctionsApp()

      app.activity('Prepare', {
        handler: () => 'ready',
      })

      assert.equal(
        getHandler()('input', invocationContext('activity-sync')),
        'ready',
      )
    })

    it('traces async activity handlers', async () => {
      const { app, getHandler } = createDurableFunctionsApp()

      app.activity('Bake', {
        handler: async () => 'baked',
      })

      const result = await getHandler()('input', invocationContext('activity-async'))
      assert.equal(result, 'baked')
    })

    it('records errors on failed activity handlers', () => {
      const { app, getHandler } = createDurableFunctionsApp()

      app.activity('Fail', {
        handler: () => {
          throw new Error('activity failed')
        },
      })

      assert.throws(
        () => getHandler()('input', invocationContext('activity-error')),
        /activity failed/,
      )
    })
  })

  describe('durable orchestration handlers', () => {
    it('exports one orchestration span across generator turns', () => {
      const { app, getHandler } = createDurableFunctionsApp()

      app.orchestration('Party', function * () {
        yield 'prepare'
        return 'done'
      })

      const gen = getHandler()(invocationContext('orch-complete'))
      assert.deepEqual(gen.next(), { value: 'prepare', done: false })
      assert.deepEqual(gen.next('input'), { value: 'done', done: true })
    })

    it('exports the orchestration span when the generator throws', () => {
      const { app, getHandler } = createDurableFunctionsApp()

      app.orchestration('Party', function * () {
        yield
        throw new Error('orchestration failed')
      })

      const gen = getHandler()(invocationContext('orch-error'))
      gen.next()
      assert.throws(() => gen.next(), /orchestration failed/)
    })

    it('skips metadata updates during replay turns', () => {
      const { app, getHandler } = createDurableFunctionsApp()

      app.orchestration('Party', function * () {
        yield 'replay'
        return 'done'
      })

      const gen = getHandler()(invocationContext('orch-replay', {
        df: { isReplaying: true },
      }))
      assert.deepEqual(gen.next(), { value: 'replay', done: false })
      assert.deepEqual(gen.next(), { value: 'done', done: true })
    })
  })
})

describe('otel-orchestration-http-link', () => {
  const {
    applyHttpParentToMeta,
    patchDurableClient,
    peekHttpParentForInstance,
    peekPendingHttpParent,
    publishHttpParentMeta,
    publishPendingHttpParent,
    resolveHttpParentForOrchestration,
    traceIdsEquivalent,
  } = require('../../src/helpers/otel-orchestration-http-link')

  before(() => {
    initTracer()
  })

  beforeEach(() => {
    process.env.DD_TRACE_AZURE_ORCHESTRATION_STORE_DIR = path.join(
      os.tmpdir(),
      `dd-orch-link-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    )
  })

  it('matches trace ids by their lower 64 bits', () => {
    assert.equal(
      traceIdsEquivalent(
        '00000000000000000000000000000001',
        '0000000000000001',
      ),
      true,
    )
  })

  it('resolves pending HTTP parents by trace id', () => {
    publishPendingHttpParent({
      traceId: '00000000000000000000000000000001',
      spanId: '0000000000000004',
    })

    assert.deepEqual(
      peekPendingHttpParent('0000000000000001'),
      {
        traceId: '00000000000000000000000000000001',
        spanId: '0000000000000004',
      },
    )
  })

  it('resolves HTTP parents stored by instance id', () => {
    publishHttpParentMeta('inst-1', {
      traceId: '00000000000000000000000000000001',
      spanId: '0000000000000004',
    })

    assert.deepEqual(peekHttpParentForInstance('inst-1').spanId, '0000000000000004')
    assert.deepEqual(
      resolveHttpParentForOrchestration('inst-1', {
        traceParent: '00-00000000000000000000000000000001-0000000000000099-01',
      }).spanId,
      '0000000000000004',
    )
  })

  it('returns the original metadata when no HTTP parent is available', () => {
    const meta = { traceId: '1', spanId: '2', parentId: '3' }
    assert.equal(applyHttpParentToMeta(meta, undefined), meta)
  })

  it('seeds orchestration metadata from startNew while an HTTP span is active', async () => {
    const { readOrchestrationSpanMetaSync } = require('../../src/helpers/otel-orchestration-store')
    const tracer = api.trace.getTracer('test')
    const parentSpan = tracer.startSpan('http StartParty')
    const ctx = api.trace.setSpan(api.context.active(), parentSpan)

    class DurableClient {
      async startNew () {
        return 'start-new-inst'
      }
    }

    patchDurableClient(DurableClient)

    await api.context.with(ctx, async () => {
      const instanceId = await new DurableClient().startNew('PartyOrchestration')
      assert.equal(instanceId, 'start-new-inst')
    })

    parentSpan.end()

    const seeded = readOrchestrationSpanMetaSync('start-new-inst')
    assert.equal(seeded.parentId.length, 16)
    assert.equal(seeded.pendingStart, true)
  })
})
