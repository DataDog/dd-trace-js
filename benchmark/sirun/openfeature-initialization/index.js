'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const proxyquire = require('proxyquire')

const guard = require('../startup-guard')

const root = process.env.DD_BENCH_SOURCE_ROOT || path.resolve(__dirname, '../../..')
const scenario = process.env.SCENARIO || 'configuration'
const operations = Number(process.env.OPERATIONS || 1_000_000)
const warmup = Number(process.env.WARMUP ?? 10_000)
assert.ok(['preloaded', 'configuration', 'error'].includes(scenario), 'Unknown initialization scenario')
assert.ok(Number.isSafeInteger(operations) && operations > 0, 'OPERATIONS must be a positive safe integer')
assert.ok(Number.isSafeInteger(warmup) && warmup >= 0, 'WARMUP must be a non-negative safe integer')

// Deliver configuration directly so network latency cannot hide the provider's initialization cost.
// The provider, upstream initialization controller, timers, promise settlement and logger remain real.
const Provider = proxyquire(path.join(root, 'packages/dd-trace/src/openfeature/flagging_provider'), {
  './configuration_source': { create () {}, '@noCallThru': true },
})
const config = {
  featureFlags: {
    DD_FLAGGING_EVALUATION_COUNTS_ENABLED: false,
    DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS: 30_000,
  },
}
const configuration = { flags: {} }
const error = new Error('Benchmark initialization failure')

async function initialize () {
  const provider = new Provider({}, config)
  if (scenario === 'preloaded') provider.setConfiguration(configuration)
  const promise = provider.initialize()
  if (scenario === 'configuration') provider.setConfiguration(configuration)
  if (scenario === 'error') provider.setError(error)
  try {
    await promise
    assert.notStrictEqual(scenario, 'error', 'Initialization must reject the supplied error')
  } catch (cause) {
    assert.strictEqual(cause, error)
    assert.strictEqual(scenario, 'error')
  }
  assert.strictEqual(provider.getConfiguration(), scenario === 'error' ? undefined : configuration)
  provider.onClose()
}

async function main () {
  for (let i = 0; i < warmup; i++) await initialize()

  guard.loopStart()
  const start = process.hrtime.bigint()
  for (let i = 0; i < operations; i++) await initialize()
  const elapsedNs = Number(process.hrtime.bigint() - start)
  guard.done()

  const output = process.env.SIRUN_VARIANT ? process.stderr : process.stdout
  output.write(JSON.stringify({
    root, scenario, operations, warmup, elapsedNs, nsPerInitialization: elapsedNs / operations,
  }) + '\n')
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
