'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

// eslint-disable-next-line import/order -- startup guard must capture third-party module load time
const dc = require('dc-polyfill')
const { storage } = require('../../../packages/datadog-core')
const createSpanContext = require('../../../packages/dd-trace/src/opentracing/span_context_factory')

const AzureCosmosPlugin = require('../../../packages/datadog-plugin-azure-cosmos/src')
const DatabasePlugin = require('../../../packages/dd-trace/src/plugins/database')

const { VARIANT } = process.env
const OPERATIONS = Number(process.env.OPERATIONS)

const SCENARIOS = {
  accepted: {
    operationType: 'query',
    resourceType: 'docs',
    path: '/dbs/orders/colls/items/docs',
    client: {
      connectionPolicy: { connectionMode: 0 },
      cosmosClientOptions: { endpoint: 'https://benchmark.documents.azure.com' },
    },
    headers: { 'User-Agent': 'azure-cosmos-benchmark' },
  },
  duplicate: {
    operationType: 'create',
    resourceType: 'docs',
    path: '/dbs/orders/colls/items/docs',
  },
  'empty-path': {
    operationType: 'read',
    resourceType: 'none',
    path: '',
  },
  'inherited-noop': {
    operationType: 'query',
    resourceType: 'docs',
    path: '/dbs/orders/colls/items/docs',
  },
}

assert.ok(SCENARIOS[VARIANT], `unknown VARIANT: ${VARIANT}`)
assert.ok(AzureCosmosPlugin.prototype instanceof DatabasePlugin)

let createdContexts = 0
let startedSpans = 0
let finishedSpans = 0

class FakeSpan {
  constructor (context, tags) {
    this._spanContext = context
    this.addTags(tags)
  }

  context () {
    return this._spanContext
  }

  addTags (tags) {
    if (!tags) return
    for (const [name, value] of Object.entries(tags)) {
      this._spanContext.setTag(name, value)
    }
  }

  setTag (name, value) {
    this._spanContext.setTag(name, value)
  }

  finish () {
    finishedSpans++
  }
}

const tracer = {
  _env: 'benchmark',
  _service: 'benchmark-app',
  _version: '1.0.0',
  _config: {
    DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT: 'continue',
    tags: {},
  },
  _nomenclature: {
    opName: () => 'cosmosdb.query',
    serviceName: () => ({ name: 'benchmark-app-azure-cosmos', source: 'azure-cosmos' }),
  },
  createSpanContext (parent) {
    createdContexts++
    return createSpanContext(this, parent, { traceId128BitGenerationEnabled: false })
  },
  startSpan (name, options) {
    startedSpans++
    const context = options.context || this.createSpanContext(options.childOf)
    context._name = name
    return new FakeSpan(context, options.tags)
  },
  extract () {},
  decodeDataStreamsContext () {},
  setCheckpoint () {},
}

const tracerConfig = {
  codeOriginForSpans: {
    enabled: false,
    experimental: { exit_spans: { enabled: false } },
  },
  peerServiceMapping: {},
  spanComputePeerService: true,
}
const plugin = new AzureCosmosPlugin(tracer, tracerConfig)
plugin.configure({
  dbmPropagationMode: 'disabled',
  enabled: true,
  service: 'benchmark-app-azure-cosmos',
})

const channel = dc.tracingChannel('orchestrion:@azure/cosmos:executePlugins')
const legacyStorage = storage('legacy')
const pluginOn = VARIANT === 'duplicate' ? 'request' : 'operation'
const response = { code: 200, substatus: 0 }
const invocations = new Array(1024)
for (let i = 0; i < invocations.length; i++) {
  invocations[i] = {
    arguments: [undefined, SCENARIOS[VARIANT], undefined, pluginOn],
    result: response,
  }
}

let activeInvocation
function finishInvocation () {
  channel.end.publish(activeInvocation)
  channel.asyncEnd.publish(activeInvocation)
}

function operationOnce (index) {
  activeInvocation = invocations[index & 1023]
  channel.start.runStores(activeInvocation, finishInvocation)
}

function runOperations (operations) {
  for (let i = 0; i < operations; i++) operationOnce(i)
}

function runInScenario (fn) {
  if (VARIANT === 'inherited-noop') {
    return legacyStorage.run({ noop: true }, fn)
  }
  return fn()
}

runInScenario(() => operationOnce(0))
if (VARIANT === 'accepted') {
  assert.strictEqual(createdContexts, 1)
  assert.strictEqual(startedSpans, 1)
  assert.strictEqual(finishedSpans, 1)
} else {
  assert.strictEqual(startedSpans, 0)
  assert.strictEqual(finishedSpans, 0)
}

createdContexts = 0
startedSpans = 0
finishedSpans = 0

const loopStartedAt = process.hrtime.bigint()
guard.loopStart()
runInScenario(() => runOperations(OPERATIONS))
const loopDuration = process.hrtime.bigint() - loopStartedAt
guard.done(0.2)

if (process.env.LOCAL_BENCHMARK_REPORT === 'true') {
  process.stdout.write(`${Number(loopDuration) / OPERATIONS}\n`)
}

if (VARIANT === 'accepted') {
  assert.strictEqual(createdContexts, OPERATIONS)
  assert.strictEqual(startedSpans, OPERATIONS)
  assert.strictEqual(finishedSpans, OPERATIONS)
} else {
  assert.strictEqual(startedSpans, 0)
  assert.strictEqual(finishedSpans, 0)
}

plugin.configure(false)
