'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const { channel } = require('dc-polyfill')

require('../../dd-trace/test/setup/core')
const PinoPlugin = require('../src/index')
const Tracer = require('../../dd-trace/src/tracer')
const getConfig = require('../../dd-trace/src/config')

const pinoLogChannel = channel('apm:pino:log')
const pinoJsonChannel = channel('apm:pino:json')

const config = {
  env: 'my-env',
  service: 'my-service',
  version: '1.2.3',
}

const tracer = new Tracer(getConfig({
  logInjection: true,
  enabled: true,
  ...config,
}))

describe('PinoPlugin', () => {
  describe('log capture (apm:pino:json channel)', () => {
    let captureSender
    let pinoPlugin

    beforeEach(() => {
      // Do NOT clear the require cache — log_plugin.js holds a top-level reference to the
      // same sender module, so we must configure the same instance.
      captureSender = require('../../dd-trace/src/log-capture/sender')
      captureSender.stop() // reset any prior state
      captureSender.configure({
        host: 'localhost',
        port: 9999,
        path: '/logs',
        protocol: 'http:',
        maxBufferSize: 1000,
        flushIntervalMs: 5000,
        timeoutMs: 5000,
      })
      pinoPlugin = new PinoPlugin({ _tracer: tracer })
    })

    afterEach(() => {
      pinoPlugin.configure({ enabled: false })
      captureSender.stop()
    })

    it('forwards pino json capture records when logCaptureEnabled is true', () => {
      pinoPlugin.configure({
        logInjection: true,
        logCaptureEnabled: true,
        enabled: true,
      })
      const rawJson = '{"level":30,"msg":"pino log"}'
      pinoJsonChannel.publish({ json: rawJson })
      assert.strictEqual(captureSender.bufferSize(), 1)
    })

    it('does not forward pino json capture records when logCaptureEnabled is false', () => {
      pinoPlugin.configure({
        logInjection: true,
        logCaptureEnabled: false,
        enabled: true,
      })
      pinoJsonChannel.publish({ json: '{"level":30,"msg":"pino log"}' })
      assert.strictEqual(captureSender.bufferSize(), 0)
    })

    it('adds raw json directly when logInjection is on', () => {
      pinoPlugin.configure({
        logInjection: true,
        logCaptureEnabled: true,
        enabled: true,
      })

      const addedLines = []
      const origAdd = captureSender.add
      captureSender.add = (json) => addedLines.push(json)

      const rawJson = '{"level":30,"msg":"raw pino","dd":{"trace_id":"abc"}}'
      pinoJsonChannel.publish({ json: rawJson })

      captureSender.add = origAdd

      assert.strictEqual(addedLines.length, 1, 'should have forwarded one record')
      assert.strictEqual(addedLines[0], rawJson, 'raw json should be passed through unchanged')
    })

    it('enriches capture records with dd trace context when logInjection is off (>=5.14.0 re-inject path)', () => {
      pinoPlugin.configure({
        logInjection: false,
        logCaptureEnabled: true,
        enabled: true,
      })

      const addedLines = []
      const origAdd = captureSender.add
      captureSender.add = (json) => addedLines.push(json)

      // Simulate pino >=5.14.0 path (wrapAsJsonForCapture): no holder in the event
      pinoJsonChannel.publish({ json: '{"level":30,"msg":"pino log"}' })

      captureSender.add = origAdd

      assert.strictEqual(addedLines.length, 1, 'capture sender should have received one enriched record')
      const parsed = JSON.parse(addedLines[0])
      // dd should be present with at least service/env/version even without an active span
      assert.ok('dd' in parsed, 'captured pino record should have dd even when logInjection is off')
      assert.strictEqual(parsed.dd.service, config.service)
      assert.strictEqual(parsed.dd.env, config.env)
      assert.strictEqual(parsed.dd.version, config.version)
    })

    it('enriches capture records using holder from wrapAsJson path when logInjection is off', () => {
      pinoPlugin.configure({
        logInjection: false,
        logCaptureEnabled: true,
        enabled: true,
      })

      const addedLines = []
      const origAdd = captureSender.add
      captureSender.add = (json) => addedLines.push(json)

      // Simulate pino <5.14.0 path (wrapAsJson): holder is provided directly in the event
      const holder = { dd: { service: 'from-holder', env: 'test', version: '0.0.1' } }
      pinoJsonChannel.publish({ json: '{"level":30,"msg":"pino log"}', holder })

      captureSender.add = origAdd

      assert.strictEqual(addedLines.length, 1, 'capture sender should have received one enriched record')
      const parsed = JSON.parse(addedLines[0])
      assert.deepStrictEqual(parsed.dd, holder.dd, 'captured record should use dd from the provided holder')
    })

    it('forwards raw json when holder exists but has no dd field', () => {
      // Covers the false branch of `if (captureHolder.dd)`.
      // Scenario: pino <5.14 wrapAsJson path publishes a holder that was never enriched by inject().
      pinoPlugin.configure({
        logInjection: false,
        logCaptureEnabled: true,
        enabled: true,
      })

      const addedLines = []
      const origAdd = captureSender.add
      captureSender.add = (json) => addedLines.push(json)

      const rawJson = '{"level":30,"msg":"no-dd log"}'
      pinoJsonChannel.publish({ json: rawJson, holder: {} })

      captureSender.add = origAdd

      assert.strictEqual(addedLines.length, 1, 'should forward raw json as fallback')
      assert.strictEqual(addedLines[0], rawJson, 'raw json should be forwarded unchanged when holder has no dd')
    })

    it('falls back to raw json when pino capture json is malformed', () => {
      pinoPlugin.configure({
        logInjection: false,
        logCaptureEnabled: true,
        enabled: true,
      })

      const addedLines = []
      const origAdd = captureSender.add
      captureSender.add = (json) => addedLines.push(json)

      const malformedJson = 'not valid json{'
      pinoJsonChannel.publish({ json: malformedJson })

      captureSender.add = origAdd

      assert.strictEqual(addedLines.length, 1, 'should still forward the raw record as fallback')
      assert.strictEqual(addedLines[0], malformedJson, 'raw malformed json should be forwarded as-is')
    })

    it('does not forward pino records from apm:pino:log (only apm:pino:json captures)', () => {
      pinoPlugin.configure({
        logInjection: false,
        logCaptureEnabled: true,
        enabled: true,
      })

      pinoLogChannel.publish({ message: { level: 30, msg: 'pino log' } })

      // apm:pino:log should NOT be captured (incomplete mixin data for >=5.14)
      assert.strictEqual(captureSender.bufferSize(), 0)
    })
  })
})
