'use strict'

const assert = require('node:assert/strict')
const { Writable } = require('node:stream')

const { channel } = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

// In the current architecture, pino exposes the fully-serialized JSON line via
// apm:pino:log:json. This channel is used for both log injection and log capture.
const jsonCh = channel('apm:pino:log:json')

describe('pino instrumentation', () => {
  withVersions('pino', 'pino', version => {
    let logger
    let stream
    let captured
    let captureSub

    beforeEach(() => {
      return agent.load('pino')
    })

    afterEach(() => {
      if (captureSub) {
        jsonCh.unsubscribe(captureSub)
        captureSub = null
      }
      return agent.close({ ritmReset: false })
    })

    beforeEach(function () {
      const pino = require(`../../../versions/pino@${version}`).get()

      if (!pino) {
        this.skip()
        return
      }

      stream = new Writable()
      stream._write = (chunk, enc, cb) => cb()
      sinon.spy(stream, 'write')

      logger = pino({}, stream)

      captured = null
      captureSub = (payload) => { captured = payload }
      jsonCh.subscribe(captureSub)
    })

    afterEach(() => {
      sinon.restore()
    })

    it('should emit to apm:pino:log:json channel on logger.info', (done) => {
      logger.info('capture test')

      setImmediate(() => {
        assert.ok(captured, 'json channel should have fired')
        const record = JSON.parse(captured.line)
        assert.strictEqual(record.msg, 'capture test')
        done()
      })
    })

    it('should include complete record fields (pid, hostname, time, level) in capture', (done) => {
      logger.info('full record test')

      setImmediate(() => {
        assert.ok(captured, 'json channel should have fired')
        const record = JSON.parse(captured.line)
        assert.ok(record.pid, 'should have pid')
        assert.ok(record.hostname, 'should have hostname')
        assert.ok(record.time, 'should have time')
        assert.ok(record.level !== undefined, 'should have level')
        assert.strictEqual(record.msg, 'full record test')
        done()
      })
    })

    it('should include extra fields in the captured record', (done) => {
      logger.info({ extra: 'field' }, 'with extra field')

      setImmediate(() => {
        assert.ok(captured, 'json channel should have fired')
        const record = JSON.parse(captured.line)
        assert.strictEqual(record.msg, 'with extra field')
        assert.strictEqual(record.extra, 'field')
        done()
      })
    })
  })

  // Separate describe for the hasSubscribers guard: loaded with logInjection disabled
  // so PinoPlugin does not subscribe to apm:pino:log:json, making the guard testable.
  withVersions('pino', 'pino', version => {
    let logger
    let stream

    beforeEach(() => {
      return agent.load('pino', { logInjection: false, logCaptureEnabled: false })
    })

    afterEach(() => {
      return agent.close({ ritmReset: false })
    })

    beforeEach(function () {
      const pino = require(`../../../versions/pino@${version}`).get()

      if (!pino) {
        this.skip()
        return
      }

      stream = new Writable()
      stream._write = (chunk, enc, cb) => cb()
      sinon.spy(stream, 'write')

      logger = pino({}, stream)
    })

    afterEach(() => {
      sinon.restore()
    })

    it('should not emit to json channel when there are no subscribers', () => {
      // PinoPlugin is disabled (logInjection=false, logCaptureEnabled=false), so the only
      // way hasSubscribers can be true is if external code subscribed — there is none here.
      assert.strictEqual(jsonCh.hasSubscribers, false)

      logger.info('no subscriber test')
    })
  })
})
