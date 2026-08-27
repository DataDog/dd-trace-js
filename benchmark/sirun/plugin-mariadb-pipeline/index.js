'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const guard = require('../startup-guard')

// eslint-disable-next-line import/order -- startup guard must capture third-party module load time
const dc = require('dc-polyfill')

const repositoryRoot = process.env.BENCHMARK_REPOSITORY_ROOT || path.resolve(__dirname, '../../..')
const { storage } = require(path.join(repositoryRoot, 'packages/datadog-core'))
const createSpanContext = require(path.join(
  repositoryRoot,
  'packages/dd-trace/src/opentracing/span_context_factory'
))
const MariadbPlugin = require(path.join(repositoryRoot, 'packages/datadog-plugin-mariadb/src'))
const Plugin = require(path.join(repositoryRoot, 'packages/dd-trace/src/plugins/plugin'))

const { VARIANT } = process.env
const OPERATIONS = Number(process.env.OPERATIONS)

assert.ok(['direct', 'disabled', 'pool'].includes(VARIANT), `unknown VARIANT: ${VARIANT}`)
assert.ok(MariadbPlugin.prototype instanceof Plugin)

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
    opName: () => 'mariadb.query',
    serviceName: () => ({ name: 'benchmark-app-mariadb', source: 'mariadb' }),
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
const plugin = new MariadbPlugin(tracer, tracerConfig)
plugin.configure(VARIANT === 'disabled'
  ? false
  : {
      dbmPropagationMode: 'disabled',
      enabled: true,
      service: 'benchmark-app-mariadb',
    })

const startChannel = dc.channel('apm:mariadb:query:start')
const finishChannel = dc.channel('apm:mariadb:query:finish')
const parentStore = { benchmark: true }
const contexts = new Array(1024)
for (let i = 0; i < contexts.length; i++) {
  contexts[i] = {
    conf: {
      database: 'inventory',
      host: '127.0.0.1',
      port: 3306,
      user: 'benchmark',
    },
    poolWaitTime: VARIANT === 'pool' ? 0.125 : undefined,
    sql: 'SELECT id, name FROM products WHERE id = ?',
  }
}

let activeContext
function finishQuery () {
  finishChannel.publish(activeContext)
}

function queryOnce (index) {
  activeContext = contexts[index & 1023]
  startChannel.runStores(activeContext, finishQuery)
}

function runQueries (operations) {
  for (let i = 0; i < operations; i++) queryOnce(i)
}

storage('legacy').run(parentStore, queryOnce, 0)
if (VARIANT === 'disabled') {
  assert.strictEqual(startedSpans, 0)
  assert.strictEqual(finishedSpans, 0)
} else {
  assert.strictEqual(createdContexts, 1)
  assert.strictEqual(startedSpans, 1)
  assert.strictEqual(finishedSpans, 1)
}

const warmupStartedAt = process.hrtime.bigint()
storage('legacy').run(parentStore, () => {
  do {
    runQueries(1024)
  } while (process.hrtime.bigint() - warmupStartedAt < 1_000_000_000n)
})

createdContexts = 0
startedSpans = 0
finishedSpans = 0

const loopStartedAt = process.hrtime.bigint()
guard.loopStart()
storage('legacy').run(parentStore, runQueries, OPERATIONS)
const loopDuration = process.hrtime.bigint() - loopStartedAt
guard.done(0.2)

if (process.env.LOCAL_BENCHMARK_REPORT === 'true') {
  process.stdout.write(`${Number(loopDuration) / OPERATIONS}\n`)
}

if (VARIANT === 'disabled') {
  assert.strictEqual(startedSpans, 0)
  assert.strictEqual(finishedSpans, 0)
} else {
  assert.strictEqual(createdContexts, OPERATIONS)
  assert.strictEqual(startedSpans, OPERATIONS)
  assert.strictEqual(finishedSpans, OPERATIONS)
}

plugin.configure(false)
