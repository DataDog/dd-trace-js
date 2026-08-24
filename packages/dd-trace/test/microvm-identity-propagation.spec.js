'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const path = require('node:path')
const { promisify } = require('node:util')

const { describe, it } = require('mocha')

require('./setup/core')

const execFileAsync = promisify(execFile)
const fixture = path.join(__dirname, 'fixtures', 'microvm-identity-propagation.js')
const METRIC_PATTERN = /^identity\.(worker|fork|spawn|disconnected|send-error)\.(before|after):1\|g\|#([^\n]+)$/gm

describe('MicroVM identity propagation', function () {
  this.timeout(20_000)

  it('refreshes existing workers and Node child processes once', async () => {
    const result = await runFixture(true)
    const runtimeIds = getRuntimeIds(result.metrics)

    for (const role of ['worker', 'fork', 'spawn']) {
      assert.ok(runtimeIds[role].before)
      assert.ok(runtimeIds[role].after)
      assert.notStrictEqual(runtimeIds[role].after, runtimeIds[role].before)
      assert.strictEqual(result.refreshCounts[role], 1)
    }

    assert.ok(runtimeIds.disconnected.before)
    assert.strictEqual(runtimeIds.disconnected.after, undefined)
    assert.ok(runtimeIds['send-error'].before)
    assert.strictEqual(runtimeIds['send-error'].after, undefined)
  })

  it('does not install descendant propagation outside MicroVMs', async () => {
    const result = await runFixture(false)
    const runtimeIds = getRuntimeIds(result.metrics)

    for (const role of ['worker', 'fork', 'spawn']) {
      assert.ok(runtimeIds[role].before)
      assert.strictEqual(runtimeIds[role].after, undefined)
      assert.strictEqual(result.refreshCounts[role], 0)
    }

    assert.ok(runtimeIds.disconnected.before)
    assert.strictEqual(runtimeIds.disconnected.after, undefined)
    assert.ok(runtimeIds['send-error'].before)
    assert.strictEqual(runtimeIds['send-error'].after, undefined)
  })
})

/**
 * @param {boolean} microvm
 * @returns {Promise<{ metrics: string[], refreshCounts: Record<string, number> }>}
 */
async function runFixture (microvm) {
  const env = {
    ...process.env,
    DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
    DD_REMOTE_CONFIGURATION_ENABLED: 'false',
    DD_RUNTIME_METRICS_ENABLED: 'false',
    DD_TRACE_ENABLED: 'true',
    DD_TRACE_STARTUP_LOGS: 'false',
    NODE_OPTIONS: '',
  }

  if (microvm) {
    env.AWS_LAMBDA_MICROVM_IMAGE_ARN = 'test-image'
  } else {
    delete env.AWS_LAMBDA_MICROVM_IMAGE_ARN
  }

  const { stdout } = await execFileAsync(process.execPath, [fixture], { env, maxBuffer: 1024 * 1024 })
  return JSON.parse(stdout)
}

/**
 * @param {string[]} payloads
 * @returns {Record<string, Record<string, string>>}
 */
function getRuntimeIds (payloads) {
  const runtimeIds = {}
  const payload = payloads.join('\n')

  for (const match of payload.matchAll(METRIC_PATTERN)) {
    const [, role, phase, tags] = match
    const runtimeId = tags.split(',').find(tag => tag.startsWith('runtime-id:'))?.slice('runtime-id:'.length)
    assert.ok(runtimeId)
    runtimeIds[role] ??= {}
    runtimeIds[role][phase] = runtimeId
  }

  return runtimeIds
}
