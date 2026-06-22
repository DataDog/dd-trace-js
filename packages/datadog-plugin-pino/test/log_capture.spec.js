'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const { channel } = require('dc-polyfill')

require('../../dd-trace/test/setup/core')
const Tracer = require('../../dd-trace/src/tracer')
const getConfig = require('../../dd-trace/src/config')

// In the current architecture, pino publishes the complete serialized JSON line
// to apm:pino:log:json with payload { line: string }.
const pinoJsonChannel = channel('apm:pino:log:json')

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
  describe('log capture (apm:pino:log:json channel)', () => {
    let captureSender
    let pinoPlugin
    let PinoPlugin

    beforeEach(() => {
      // sender.spec.js busts the sender require cache in its own beforeEach, which
      // disconnects log_plugin.js's module-level sender reference from the instance
      // the test configures. Bust all three caches together so they share one instance.
      delete require.cache[require.resolve('../../dd-trace/src/log-capture/sender')]
      delete require.cache[require.resolve('../../dd-trace/src/plugins/log_plugin')]
      delete require.cache[require.resolve('../src/index')]

      PinoPlugin = require('../src/index')
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
      pinoJsonChannel.publish({ line: rawJson })
      assert.strictEqual(captureSender.bufferSize(), 1)
    })

    it('does not forward pino json capture records when logCaptureEnabled is false', () => {
      pinoPlugin.configure({
        logInjection: true,
        logCaptureEnabled: false,
        enabled: true,
      })
      pinoJsonChannel.publish({ line: '{"level":30,"msg":"pino log"}' })
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
      try {
        // When logInjection is on, handleJsonLine splices dd into the line first.
        // Simulate a line that already has dd (as pino would produce after injection).
        const rawJson = '{"level":30,"msg":"raw pino","dd":{"trace_id":"abc"}}'
        pinoJsonChannel.publish({ line: rawJson })
      } finally {
        captureSender.add = origAdd
      }

      assert.strictEqual(addedLines.length, 1, 'should have forwarded one record')
    })

    it('enriches capture records with dd trace context when logInjection is off', () => {
      pinoPlugin.configure({
        logInjection: false,
        logCaptureEnabled: true,
        enabled: true,
      })

      const addedLines = []
      const origAdd = captureSender.add
      captureSender.add = (json) => addedLines.push(json)
      try {
        pinoJsonChannel.publish({ line: '{"level":30,"msg":"pino log"}' })
      } finally {
        captureSender.add = origAdd
      }

      assert.strictEqual(addedLines.length, 1, 'capture sender should have received one enriched record')
      const parsed = JSON.parse(addedLines[0])
      // dd should be present with at least service/env/version even without an active span
      assert.ok('dd' in parsed, 'captured pino record should have dd even when logInjection is off')
      assert.strictEqual(parsed.dd.service, config.service)
      assert.strictEqual(parsed.dd.env, config.env)
      assert.strictEqual(parsed.dd.version, config.version)
    })

    it('does not forward pino records when logCaptureEnabled is false (no-op check)', () => {
      pinoPlugin.configure({
        logInjection: false,
        logCaptureEnabled: false,
        enabled: true,
      })

      // apm:pino:log:json should NOT trigger capture when both injection and capture are off
      pinoJsonChannel.publish({ line: '{"level":30,"msg":"pino log"}' })

      assert.strictEqual(captureSender.bufferSize(), 0)
    })
  })
})
