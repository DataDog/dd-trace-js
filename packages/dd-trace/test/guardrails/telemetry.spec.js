'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, before } = require('mocha')
const { EventEmitter } = require('events')
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

  describe('Error scenarios and metadata', () => {
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

    function runTelemetry (eventType, value) {
      const originalStringify = JSON.stringify
      JSON.stringify = function (obj) {
        if (obj && obj.metadata && obj.points) {
          if (eventType === 'spawn-error') {
            mockProc.emit('error', new Error(value))
          } else if (eventType === 'exit') {
            mockProc.emit('exit', value)
          } else if (eventType === 'stdin-error') {
            mockProc.stdin.emit('error', new Error(value))
          }
        }
        return originalStringify.apply(this, arguments)
      }

      try {
        telemetryModule([{ name: 'test', tags: [] }])
      } finally {
        JSON.stringify = originalStringify
      }
    }

    function assertStdinMetadata (expected) {
      expect(capturedStdinData).to.exist
      const parsed = JSON.parse(capturedStdinData)
      expect(parsed.metadata.result).to.equal(expected.result)
      expect(parsed.metadata.result_class).to.equal(expected.result_class)
      expect(parsed.metadata.result_reason).to.equal(expected.result_reason)
    }

    beforeEach(() => {
      mockProc = createMockProcess()
      capturedStdinData = null
      telemetryModule = loadTelemetryModuleWithMockProc()
    })

    it('should set error metadata when telemetry forwarder fails to spawn', () => {
      runTelemetry('spawn-error', 'Spawn failed')

      assertStdinMetadata({
        result: 'error',
        result_class: 'internal_error',
        result_reason: 'Failed to spawn telemetry forwarder'
      })
    })

    it('should set error metadata when telemetry forwarder exits with non-zero code', () => {
      runTelemetry('exit', 1)

      assertStdinMetadata({
        result: 'error',
        result_class: 'internal_error',
        result_reason: 'Telemetry forwarder exited with code 1'
      })
    })

    it('should set error metadata when writing to telemetry forwarder fails', () => {
      runTelemetry('stdin-error', 'Write failed')

      assertStdinMetadata({
        result: 'error',
        result_class: 'internal_error',
        result_reason: 'Failed to write telemetry data to telemetry forwarder'
      })
    })

    it('should set success metadata when telemetry forwarder exits successfully', () => {
      runTelemetry('exit', 0)

      assertStdinMetadata({
        result: 'success',
        result_class: 'success',
        result_reason: 'Successfully configured ddtrace package'
      })
    })
  })
})
