'use strict'

// Load timing starts before dependencies, as required by the sirun startup guard.
// eslint-disable-next-line import/order
const guard = require('../startup-guard')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { OpenFeature } = require('@openfeature/server-sdk')
const proxyquire = require('proxyquire')

const { evaluationContext } = require('./context')

globalThis[Symbol.for('dd-trace')] ??= { beforeExitHandlers: new Set() }

const root = process.env.DD_BENCH_SOURCE_ROOT || path.resolve(__dirname, '../../..')
const source = path.join(root, 'packages/dd-trace/src/openfeature')
const consent = process.env.CONSENT === 'true'
const shape = process.env.VARIANT || 'typical'
const operations = Number(process.env.OPERATIONS || 1_000_000)
assert.ok(Number.isSafeInteger(operations) && operations > 0)
const hasEVP = fs.existsSync(path.join(source, 'writers/flag-eval-evp-hook.js'))
let collected = 0
let rows = 0
let bytes = 0
let privacyValid = true
const overrides = {
  './configuration_source': { create () {} },
}
if (process.env.DD_BENCH_PROVIDER_MODULE) {
  overrides['../../../../vendor/dist/@datadog/openfeature-node-server'] = require(process.env.DD_BENCH_PROVIDER_MODULE)
}
if (hasEVP) {
  const Base = proxyquire(path.join(source, 'writers/base'), {
    '../../exporters/common/request': (body, options, callback) => {
      const payload = JSON.parse(body)
      for (const row of payload.flagEvaluations) {
        collected += row.evaluation_count
        privacyValid &&= (row.context !== undefined) === consent
        privacyValid &&= row.targeting_key?.startsWith('sha256_') === !consent
      }
      rows += payload.flagEvaluations.length
      bytes += Buffer.byteLength(body)
      callback(null, '', 202)
    },
  })
  const Writer = proxyquire(path.join(source, 'writers/flag-evaluations'), { './base': Base })
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
const config = {
  url: new URL('http://localhost:8126'),
  service: 'openfeature-benchmark',
  featureFlags: { DD_FEATURE_FLAGS_EVALUATION_COUNTS_ENABLED: true },
  experimental: { flaggingProvider: { initializationTimeoutMs: 1000 } },
}
const provider = new Provider({}, config)
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

async function main () {
  try {
    await OpenFeature.setProviderAndWait('evp-benchmark', provider)
    const client = OpenFeature.getClient('evp-benchmark')
    const context = evaluationContext(shape)
    const preflight = await client.getBooleanDetails('flag', false, context)
    assert.strictEqual(preflight.value, true)
    assert.strictEqual(preflight.variant, 'on')
    if (consent) {
      assert.strictEqual(preflight.flagMetadata.__dd_observe_full_evaluation_data, true,
        'Full-consent timing requires a provider artifact producing real consent metadata')
    }
    const warmup = Number(process.env.WARMUP || 5000)
    for (let i = 0; i < warmup; i++) {
      assert.strictEqual(await client.getBooleanValue('flag', false, context), true)
      if (i % 256 === 255) await new Promise(resolve => setImmediate(resolve))
    }
    await new Promise(resolve => setImmediate(resolve))
    global.gc?.()
    const heapBefore = process.memoryUsage().heapUsed
    const start = process.hrtime.bigint()
    guard.loopStart()
    for (let i = 0; i < operations; i++) {
      assert.strictEqual(await client.getBooleanValue('flag', false, context), true)
      // Let the real deferred drain run before the 4096-event queue fills.
      if (i % 256 === 255) await new Promise(resolve => setImmediate(resolve))
    }
    provider.onClose()
    const elapsedNs = Number(process.hrtime.bigint() - start)
    const heapAfter = process.memoryUsage().heapUsed
    guard.done()
    assert.strictEqual(collected, hasEVP ? operations + warmup + 1 : 0)
    assert.ok(privacyValid, 'Collected rows must match the requested privacy mode')
    process.stdout.write(JSON.stringify({
      root,
      providerArtifact: process.env.DD_BENCH_PROVIDER_MODULE || 'repository vendor bundle',
      hasEVP,
      consent,
      shape,
      operations,
      warmup,
      batchSize: 256,
      elapsedNs,
      nsPerEvaluation: elapsedNs / operations,
      heapDeltaBytes: heapAfter - heapBefore,
      collected,
      rows,
      bytes,
    }) + '\n')
  } finally {
    provider.onClose()
    await OpenFeature.clearProviders()
    assert.strictEqual(globalThis[Symbol.for('dd-trace')].beforeExitHandlers.size, 0)
  }
}

main().catch(error => {
  process.stderr.write(error.stack + '\n')
  process.exitCode = 1
})
