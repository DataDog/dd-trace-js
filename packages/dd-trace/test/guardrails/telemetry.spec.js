'use strict'

process.env.DD_INJECTION_ENABLED = 'true'

const assert = require('assert')
const proxyquire = require('proxyquire')
const { EventEmitter } = require('events')
const { telemetryForwarder, assertTelemetryPoints } = require('../../../../integration-tests/helpers')

describe('sendTelemetry', () => {
  let cleanup, sendTelemetry

  before(function () {
    if (['1', 'true', 'True'].includes(process.env.DD_INJECT_FORCE)) {
      // When DD_INJECT_FORCE is set, only telemetry with the name `error` or `complete` is sent
      this.skip()
    }
  })

  beforeEach(() => {
    cleanup = telemetryForwarder()
    sendTelemetry = proxyquire('../src/guardrails/telemetry', {})
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

  describe('error scenarios and metadata', () => {
    let mockProc, telemetryModule, spawnStub

    beforeEach(() => {
      mockProc = new EventEmitter()
      mockProc.stdin = new EventEmitter()
      mockProc.stdin.end = function () {}
      mockProc.pid = 12345

      spawnStub = function () { return mockProc }

      telemetryModule = proxyquire('../../src/guardrails/telemetry', {
        'child_process': { spawn: spawnStub }
      })
    })

    it('should set error metadata when telemetry forwarder fails to spawn', () => {
      telemetryModule([{ name: 'test', tags: [] }])
      mockProc.emit('error', new Error('Spawn failed'))

      assert.strictEqual(telemetryModule.resultMetadata.result, 'error')
      assert.strictEqual(telemetryModule.resultMetadata.result_class, 'internal_error')
      assert.strictEqual(telemetryModule.resultMetadata.result_reason, 'Failed to spawn telemetry forwarder')
    })

    it('should set error metadata when telemetry forwarder exits with non-zero code', () => {
      telemetryModule([{ name: 'test', tags: [] }])
      mockProc.emit('exit', 1)

      assert.strictEqual(telemetryModule.resultMetadata.result, 'error')
      assert.strictEqual(telemetryModule.resultMetadata.result_class, 'internal_error')
      assert.strictEqual(telemetryModule.resultMetadata.result_reason, 'Telemetry forwarder exited with code 1')
    })

    it('should set error metadata when writing to telemetry forwarder fails', () => {
      telemetryModule([{ name: 'test', tags: [] }])
      mockProc.stdin.emit('error', new Error('Write failed'))

      assert.strictEqual(telemetryModule.resultMetadata.result, 'error')
      assert.strictEqual(telemetryModule.resultMetadata.result_class, 'internal_error')
      assert.strictEqual(telemetryModule.resultMetadata.result_reason, 'Failed to write telemetry data to telemetry forwarder')
    })

    it('should set success metadata when telemetry forwarder exits successfully', () => {
      telemetryModule.resultMetadata.result = 'unknown'
      telemetryModule.resultMetadata.result_class = 'unknown'
      telemetryModule.resultMetadata.result_reason = 'unknown'

      telemetryModule([{ name: 'test', tags: [] }])
      mockProc.emit('exit', 0)

      assert.strictEqual(telemetryModule.resultMetadata.result, 'success')
      assert.strictEqual(telemetryModule.resultMetadata.result_class, 'success')
      assert.strictEqual(telemetryModule.resultMetadata.result_reason, 'Successfully configured ddtrace package')
    })
  })
})
