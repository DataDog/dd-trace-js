'use strict'

const assert = require('node:assert/strict')

const { afterEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const { realtimeEnabled } = require('../../src/openai-realtime')

/**
 * Resolve the kill switch against stubbed stable-config sources, the way an org that sets it
 * through Fleet Automation or `/etc/datadog-agent/application_monitoring.yaml` would.
 *
 * @param {{ fleet?: Record<string, string>, local?: Record<string, string> }} sources
 */
function realtimeEnabledWith ({ fleet = {}, local = {} }) {
  const StableConfigStub = sinon.stub().callsFake(function () {
    this.localEntries = local
    this.fleetEntries = fleet
    this.warnings = []
  })

  const helper = proxyquire('../../../dd-trace/src/config/helper', {
    '../serverless': { IS_SERVERLESS: false },
    './stable': StableConfigStub,
  })

  return proxyquire('../../src/openai-realtime', {
    '../../../dd-trace/src/config/helper': helper,
  }).realtimeEnabled()
}

describe('openai realtime kill switch', () => {
  afterEach(() => {
    delete process.env.DD_OPENAI_REALTIME_ENABLED
  })

  it('is on by default', () => {
    assert.strictEqual(realtimeEnabled(), true)
  })

  it('is off when explicitly disabled', () => {
    // Realtime is a large wrapping surface that buffers audio in memory, so it can be turned off on
    // its own without giving up the rest of the OpenAI integration.
    for (const value of ['false', 'FALSE', '0']) {
      process.env.DD_OPENAI_REALTIME_ENABLED = value
      assert.strictEqual(realtimeEnabled(), false, value)
    }
  })

  it('stays on for any other value', () => {
    for (const value of ['true', '1', '', 'yes']) {
      process.env.DD_OPENAI_REALTIME_ENABLED = value
      assert.strictEqual(realtimeEnabled(), true, value)
    }
  })

  // The switch is operator-facing, so it has to honor every source `Config` resolves it from.
  // Reading `process.env` alone leaves the patching on while configuration telemetry reports the
  // option as disabled — a divergence with no symptom to chase.
  it('is off when disabled through fleet or local stable config', () => {
    assert.strictEqual(realtimeEnabledWith({ fleet: { DD_OPENAI_REALTIME_ENABLED: 'false' } }), false)
    assert.strictEqual(realtimeEnabledWith({ local: { DD_OPENAI_REALTIME_ENABLED: 'false' } }), false)
  })

  it('lets fleet stable config override a local opt-out', () => {
    assert.strictEqual(realtimeEnabledWith({
      fleet: { DD_OPENAI_REALTIME_ENABLED: 'true' },
      local: { DD_OPENAI_REALTIME_ENABLED: 'false' },
    }), true)
  })

  it('is on when no source sets it', () => {
    assert.strictEqual(realtimeEnabledWith({}), true)
  })
})
