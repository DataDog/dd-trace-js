'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const path = require('node:path')
const { promisify } = require('node:util')

const { describe, it } = require('mocha')

const { BUN } = require('../../../../integration-tests/helpers/bun')

const execFileAsync = promisify(execFile)
const gcFixture = path.join(__dirname, 'fixtures', 'diagnostics-channel-gc.js')
const startupFixture = path.join(__dirname, 'fixtures', 'diagnostics-channel-startup.js')

describe('bun/diagnostics-channel', () => {
  it('keeps active channels alive across garbage collection on Bun and releases inactive ones', async () => {
    const { stdout } = await execFileAsync(BUN, [gcFixture], {
      timeout: 30_000,
      env: { ...process.env, DD_TRACE_ENABLED: 'true' },
    })

    assert.deepStrictEqual(JSON.parse(stdout), {
      delivered: ['channel', 'top-level', 'tracing', 'mixed'],
      storeBound: true,
      unsubscribedCollected: true,
      unboundCollected: true,
    })
  })

  for (const [scenario, description] of [
    ['node', 'leaves diagnostics channels untouched on Node.js'],
    ['disabled', 'leaves diagnostics channels untouched when tracing is disabled'],
    ['frozen', 'starts without patching a frozen channel prototype'],
    ['read-only', 'starts without partially patching a channel prototype with a read-only method'],
  ]) {
    it(description, async () => {
      const runtime = scenario === 'node' ? process.execPath : BUN
      await execFileAsync(runtime, [startupFixture, scenario], {
        timeout: 30_000,
        env: { ...process.env, DD_TRACE_ENABLED: scenario === 'disabled' ? 'false' : 'true' },
      })
    })
  }
})
