'use strict'

// Load timing starts before dependencies, as required by the sirun startup guard.
// eslint-disable-next-line import/order
const guard = require('../startup-guard')
const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { Worker } = require('node:worker_threads')

const { OpenFeature } = require('@openfeature/server-sdk')
const proxyquire = require('proxyquire')

const { evaluationContext } = require('./context')

globalThis[Symbol.for('dd-trace')] ??= { beforeExitHandlers: new Set() }

const root = process.env.DD_BENCH_SOURCE_ROOT || path.resolve(__dirname, '../../..')
const source = path.join(root, 'packages/dd-trace/src/openfeature')
const consent = process.env.CONSENT === 'true'
const shape = process.env.VARIANT || 'typical'
const operations = Number(process.env.OPERATIONS || 1_000_000)
const warmup = Number(process.env.WARMUP ?? 5000)
const saturated = process.env.SATURATED === 'true'
assert.ok(Number.isSafeInteger(operations) && operations > 0, 'OPERATIONS must be a positive safe integer')
assert.ok(Number.isSafeInteger(warmup) && warmup >= 0, 'WARMUP must be a non-negative safe integer')
const hasEVP = fs.existsSync(path.join(source, 'writers/flag-eval-evp-hook.js'))
const metrics = hasEVP ? require(path.join(root, 'packages/dd-trace/src/telemetry/metrics')) : undefined
let collected = 0
let rows = 0
let bytes = 0
let privacyValid = true
let collectorError
let collectorUrl
let collector
let collectorExited = false
let collectorClosing = false
let evaluationWriter
let provider
let admissionWaitNs = 0
let workerCount = 0
const workerExitCodes = []

const overrides = { './configuration_source': { create () {} } }
if (process.env.DD_BENCH_PROVIDER_MODULE) {
  overrides['../../../../vendor/dist/@datadog/openfeature-node-server'] = require(process.env.DD_BENCH_PROVIDER_MODULE)
}
if (hasEVP) {
  class ObservedWorker extends Worker {
    constructor (...args) {
      super(...args)
      workerCount++
      this.once('exit', code => workerExitCodes.push(code))
    }
  }
  const Producer = proxyquire(path.join(source, 'writers/flag-evaluations'), {
    'node:worker_threads': { Worker: ObservedWorker },
  })
  // Capture ownership without replacing enqueue, aggregation, serialization, worker creation or transport.
  class Writer extends Producer {
    constructor (...args) {
      super(...args)
      evaluationWriter = this
    }
  }
  Writer['@noCallThru'] = true
  overrides['./writers/flag-eval-evp-hook'] = proxyquire(path.join(source, 'writers/flag-eval-evp-hook'), {
    './flag-evaluations': Writer,
    './util': {
      setExposureDeliveryStrategy: (config, onRoute) => onRoute(true, {
        url: config.url, basePath: '/evp_proxy/v2',
      }),
    },
  })
}
const Provider = proxyquire(path.join(source, 'flagging_provider'), overrides)

function droppedCounts () {
  const series = metrics?.manager.namespace('general').toJSON().metrics?.series ?? []
  const counts = {}
  for (const metric of series) {
    if (metric.metric !== 'flagevaluation.rows.dropped') continue
    counts[metric.tags.find(tag => tag.startsWith('reason:'))] = metric.points[0][1]
  }
  return counts
}

/**
 * @param {() => boolean} condition
 * @param {string} phase
 */
async function waitFor (condition, phase) {
  const deadline = Date.now() + 15000
  while (!condition()) {
    if (collectorError) throw collectorError
    assert.ok(Date.now() < deadline,
      `${phase} timed out: collected=${collected}, dropped=${JSON.stringify(droppedCounts())}`)
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  if (collectorError) throw collectorError
}

async function waitForCapacity () {
  if (!evaluationWriter || evaluationWriter.hasCapacity()) return
  const start = process.hrtime.bigint()
  await waitFor(() => evaluationWriter.hasCapacity(), 'admission')
  admissionWaitNs += Number(process.hrtime.bigint() - start)
}

async function main () {
  try {
    collector = fork(path.join(__dirname, 'collector.js'), [String(consent)], {
      execArgv: [],
      env: { ...process.env, NODE_OPTIONS: '' },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    })
    collector.once('error', error => { collectorError = error })
    collector.once('exit', (code, signal) => {
      collectorExited = true
      if (!collectorClosing) collectorError = new Error(`Collector exited early: code=${code}, signal=${signal}`)
    })
    collector.on('message', message => {
      if (message.type === 'ready') collectorUrl = message.url
      else if (message.type === 'error') collectorError = new Error(message.message)
      else if (message.type === 'stats') ({ collected, rows, bytes, privacyValid } = message)
    })
    await waitFor(() => collectorUrl !== undefined, 'collector startup')
    const config = {
      url: new URL(collectorUrl),
      service: 'openfeature-benchmark',
      featureFlags: {
        DD_FLAGGING_EVALUATION_COUNTS_ENABLED: true,
        DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS: 1000,
      },
      // The same benchmark fixture also runs against baseline revisions with the legacy internal config shape.
      experimental: { flaggingProvider: { initializationTimeoutMs: 1000 } },
    }
    provider = new Provider({}, config)
    provider.setConfiguration({
      createdAt: '2026-09-21T00:00:00.000Z',
      format: 'SERVER',
      environment: { name: 'benchmark' },
      observeFullEvaluationData: consent,
      flags: {
        flag: {
          key: 'flag',
          enabled: true,
          variationType: 'BOOLEAN',
          variations: { on: { key: 'on', value: true } },
          allocations: [{ key: 'all', rules: [], splits: [{ variationKey: 'on', shards: [] }], doLog: false }],
        },
      },
    })
    await OpenFeature.setProviderAndWait('evp-benchmark', provider)
    const client = OpenFeature.getClient('evp-benchmark')
    const context = evaluationContext(shape)
    const preflight = await client.getBooleanDetails('flag', false, context)
    assert.strictEqual(preflight.value, true)
    assert.strictEqual(preflight.variant, 'on')
    // A historical tracer without EVP cannot collect identity/context at all.
    // Every EVP-capable source must still prove the real evaluator granted consent.
    if (consent && hasEVP) {
      assert.strictEqual(preflight.flagMetadata.__dd_observe_full_evaluation_data, true,
        'Full-consent timing requires a provider artifact producing real consent metadata')
    }
    // Establish worker readiness even with WARMUP=0; account for it as setup, never measured loop time.
    evaluationWriter?.flush()
    await waitFor(() => collected === Number(hasEVP), 'preflight delivery')
    for (let i = 0; i < warmup; i++) {
      if (evaluationWriter && !evaluationWriter.hasCapacity()) await waitForCapacity()
      assert.strictEqual(await client.getBooleanValue('flag', false, context), true)
      if (i % 256 === 255) await new Promise(resolve => setImmediate(resolve))
    }
    evaluationWriter?.flush()
    await waitFor(() => collected === (hasEVP ? warmup + 1 : 0), 'warmup delivery')
    const setupCollected = collected
    const setupRows = rows
    const setupBytes = bytes
    admissionWaitNs = 0
    global.gc?.()
    const heapBefore = process.memoryUsage().heapUsed
    const start = process.hrtime.bigint()
    guard.loopStart()
    for (let i = 0; i < operations; i++) {
      if (!saturated && evaluationWriter && !evaluationWriter.hasCapacity()) await waitForCapacity()
      assert.strictEqual(await client.getBooleanValue('flag', false, context), true)
      if (!saturated && i % 256 === 255) await new Promise(resolve => setImmediate(resolve))
    }
    const evaluationLoopNs = Number(process.hrtime.bigint() - start)
    // Final network drain must not dilute the unchanged startup regression guard.
    guard.done()
    const drainStart = process.hrtime.bigint()
    provider.onClose()
    const expected = hasEVP ? operations + warmup + 1 : 0
    await waitFor(() => {
      const dropped = Object.values(droppedCounts()).reduce((sum, count) => sum + count, 0)
      return collected + dropped >= expected && workerExitCodes.length === workerCount
    }, 'final delivery')
    const drainElapsedNs = Number(process.hrtime.bigint() - drainStart)
    const heapAfter = process.memoryUsage().heapUsed
    const dropped = droppedCounts()
    const droppedCount = Object.values(dropped).reduce((sum, count) => sum + count, 0)
    assert.ok(workerExitCodes.every(code => code === 0), `Worker drain failed: exit codes ${workerExitCodes}`)
    assert.strictEqual(collected + droppedCount, expected, 'Every attempted evaluation must be delivered or counted')
    if (!saturated) assert.strictEqual(droppedCount, 0, 'Capacity-paced runs must deliver every evaluation')
    else {
      assert.ok(Object.keys(dropped).every(reason =>
        reason === 'reason:pre_queue_overflow' || reason === 'reason:queue_overflow'),
      'Saturated runs may drop only at input capacity')
    }
    assert.ok(privacyValid, 'Collected rows must match the requested privacy mode')
    const elapsedNs = evaluationLoopNs + drainElapsedNs
    // Sirun inherits stdout for its own NDJSON measurement records.
    const output = process.env.SIRUN_VARIANT ? process.stderr : process.stdout
    output.write(JSON.stringify({
      root,
      providerArtifact: process.env.DD_BENCH_PROVIDER_MODULE || 'repository vendor bundle',
      boundary: 'real SDK/provider and production EVP delivery to loopback HTTP',
      collectorBoundary: 'separate child process; excluded from SDK process CPU and memory',
      delivery: workerCount > 0 ? 'worker' : hasEVP ? 'same-thread' : 'none',
      hasEVP,
      consent,
      evaluationConsentMetadata: preflight.flagMetadata.__dd_observe_full_evaluation_data ?? null,
      shape,
      operations,
      warmup,
      saturated,
      batchSize: saturated ? operations : 256,
      elapsedNs,
      evaluationLoopNs,
      admissionWaitNs,
      evaluationElapsedNs: evaluationLoopNs - admissionWaitNs,
      drainElapsedNs,
      nsPerEvaluation: evaluationLoopNs / operations,
      heapDeltaBytes: heapAfter - heapBefore,
      collected,
      measuredCollected: collected - setupCollected,
      dropped,
      workerCount,
      rows,
      bytes,
      measuredRows: rows - setupRows,
      measuredBytes: bytes - setupBytes,
    }) + '\n')
  } finally {
    try {
      provider?.onClose()
      await OpenFeature.clearProviders()
      await waitFor(() => workerExitCodes.length === workerCount, 'worker cleanup')
    } finally {
      collectorClosing = true
      if (collector && !collectorExited) {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            collector.kill('SIGKILL')
            reject(new Error('Collector cleanup timed out after 5000ms'))
          }, 5000)
          collector.once('exit', (code, signal) => {
            clearTimeout(timeout)
            if (code === 0) resolve()
            else reject(new Error(`Collector cleanup failed: code=${code}, signal=${signal}`))
          })
          if (collector.connected) collector.send('close')
          else collector.kill()
        })
      }
    }
    assert.strictEqual(globalThis[Symbol.for('dd-trace')].beforeExitHandlers.size, 0)
  }
}

main().catch(error => {
  process.stderr.write(error.stack + '\n')
  process.exitCode = 1
})
