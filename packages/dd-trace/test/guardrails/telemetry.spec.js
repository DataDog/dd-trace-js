'use strict'

const { EventEmitter } = require('events')
const assert = require('node:assert/strict')

const { before, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')

const { telemetryForwarder, assertTelemetryPoints } = require('../../../../integration-tests/helpers')
process.env.DD_INJECTION_ENABLED = 'true'

describe('sendTelemetry', () => {
  let cleanup, sendTelemetry

  before(function () {
    if (['1', 'true', 'True'].includes(process.env.DD_INJECT_FORCE ?? '')) {
      // When DD_INJECT_FORCE is set, only telemetry with the name `error` or `complete` is sent
      this.skip()
    }
  })

  beforeEach(() => {
    cleanup = telemetryForwarder()
    sendTelemetry = proxyquire('../../src/guardrails/telemetry', {})
  })

  it('should send telemetry', async () => {
    sendTelemetry([
      { name: 'abort', tags: ['1'] },
      { name: 'abort.integration', tags: ['2'] },
      { name: 'abort.integration', tags: ['3'] },
      { name: 'foo', tags: ['4'] }
    ])
    const msgs = await cleanup()
    assertTelemetryPoints(process.pid, msgs, [
      'abort', '1',
      'abort.integration', '2',
      'abort.integration', '3',
      'foo', '4'
    ])
  })

  describe('no duplicates', () => {
    it('should not send `abort` more than once in the same call', async () => {
      sendTelemetry([
        { name: 'abort', tags: ['1'] },
        { name: 'abort', tags: ['2'] }
      ])
      const msgs = await cleanup()
      assertTelemetryPoints(process.pid, msgs, ['abort', '1'])
    })

    it('should not send `abort` more than once in a different call', async () => {
      sendTelemetry('abort', ['1'])
      sendTelemetry('abort', ['2'])
      const msgs = await cleanup()
      assertTelemetryPoints(process.pid, msgs, ['abort', '1'])
    })

    it('should not send `abort.integration` more than once if tags are the same in the same call', async () => {
      sendTelemetry([
        { name: 'abort.integration', tags: ['1'] },
        { name: 'abort.integration', tags: ['1'] }
      ])
      const msgs = await cleanup()
      assertTelemetryPoints(process.pid, msgs, ['abort.integration', '1'])
    })

    it('should not send `abort.integration` more than once if tags are the same in a different call', async () => {
      sendTelemetry('abort.integration', ['1'])
      sendTelemetry('abort.integration', ['1'])
      const msgs = await cleanup()
      assertTelemetryPoints(process.pid, msgs, ['abort.integration', '1'])
    })
  })

  describe('Result metadata parameter', () => {
    let mockProc, telemetryModule, capturedStdinData

    function createMockProcess () {
      const proc = new EventEmitter()
      proc.stdin = new EventEmitter()
      proc.stdin.end = (data) => {
        capturedStdinData = data
      }
      return proc
    }

    function loadTelemetryModuleWithMockProc () {
      return proxyquire('../../src/guardrails/telemetry', {
        child_process: { spawn: () => mockProc }
      })
    }

    function assertStdinMetadata (expected) {
      assert.ok(capturedStdinData != null)
      const parsed = JSON.parse(capturedStdinData)
      assert.strictEqual(parsed.metadata.result, expected.result)
      assert.strictEqual(parsed.metadata.result_class, expected.result_class)
      assert.strictEqual(parsed.metadata.result_reason, expected.result_reason)
    }

    beforeEach(() => {
      mockProc = createMockProcess()
      capturedStdinData = null
      telemetryModule = loadTelemetryModuleWithMockProc()
    })

    it('should use provided result metadata', () => {
      telemetryModule([{ name: 'error', tags: ['integration:express'] }], undefined, {
        result: 'error',
        result_class: 'internal_error',
        result_reason: 'Error during instrumentation of express@4.18.0: TypeError'
      })

      assertStdinMetadata({
        result: 'error',
        result_class: 'internal_error',
        result_reason: 'Error during instrumentation of express@4.18.0: TypeError'
      })
    })

    it('should use provided result metadata for abort scenarios', () => {
      telemetryModule('abort.integration', ['integration:redis'], {
        result: 'abort',
        result_class: 'incompatible_library',
        result_reason: 'Incompatible integration version: redis@2.8.0'
      })

      assertStdinMetadata({
        result: 'abort',
        result_class: 'incompatible_library',
        result_reason: 'Incompatible integration version: redis@2.8.0'
      })
    })

    it('should default to unknown values when no metadata provided', () => {
      telemetryModule([{ name: 'test', tags: [] }])

      assertStdinMetadata({
        result: 'unknown',
        result_class: 'unknown',
        result_reason: 'unknown'
      })
    })

    it('should partially override default metadata', () => {
      telemetryModule('error', ['integration:mongodb'], {
        result: 'error',
        result_reason: 'Connection failed'
      })

      assertStdinMetadata({
        result: 'error',
        result_class: 'unknown',
        result_reason: 'Connection failed'
      })
    })
  })
})
