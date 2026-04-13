'use strict'

const assert = require('node:assert/strict')
const { Writable } = require('node:stream')

const { channel } = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const semver = require('semver')
const sinon = require('sinon')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

const captureCh = channel('apm:pino:json')

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
        captureCh.unsubscribe(captureSub)
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
      captureCh.subscribe(captureSub)
    })

    afterEach(() => {
      sinon.restore()
    })

    it('should emit to apm:pino:json channel on logger.info', (done) => {
      logger.info('capture test')

      setImmediate(() => {
        assert.ok(captured, 'capture channel should have fired')
        const record = JSON.parse(captured.json)
        assert.strictEqual(record.msg, 'capture test')
        done()
      })
    })

    it('should include complete record fields (pid, hostname, time, level) in capture', (done) => {
      logger.info('full record test')

      setImmediate(() => {
        assert.ok(captured, 'capture channel should have fired')
        const record = JSON.parse(captured.json)
        assert.ok(record.pid, 'should have pid')
        assert.ok(record.hostname, 'should have hostname')
        assert.ok(record.time, 'should have time')
        assert.ok(record.level !== undefined, 'should have level')
        assert.strictEqual(record.msg, 'full record test')
        done()
      })
    })

    if (semver.intersects(version, '>=5.14.0')) {
      it('should publish to capture channel from wrapAsJsonForCapture (>=5.14.0 path)', (done) => {
        logger.info({ extra: 'field' }, 'mixin path capture')

        setImmediate(() => {
          assert.ok(captured, 'capture channel should have fired on >=5.14.0 path')
          const record = JSON.parse(captured.json)
          assert.strictEqual(record.msg, 'mixin path capture')
          assert.strictEqual(record.extra, 'field')
          done()
        })
      })

      it('should not include holder in capture payload for >=5.14.0 (wrapAsJsonForCapture)', (done) => {
        logger.info('capture no holder')

        setImmediate(() => {
          assert.ok(captured, 'capture channel should have fired')
          // wrapAsJsonForCapture does not provide holder — the log_plugin re-injects from current context
          assert.ok(!('holder' in captured), 'holder should not be present in >=5.14.0 capture payload')
          done()
        })
      })
    }

    if (semver.intersects(version, '>=5 <5.14.0')) {
      it('should include holder in capture payload for <5.14.0 (wrapAsJson path)', (done) => {
        logger.info('capture with holder')

        setImmediate(() => {
          assert.ok(captured, 'capture channel should have fired')
          // wrapAsJson provides holder so log_plugin can enrich with dd trace context
          assert.ok('holder' in captured, 'holder should be present in <5.14.0 capture payload')
          done()
        })
      })
    }
  })

  // Separate describe for the hasSubscribers guard: loaded with logInjection and logCaptureEnabled
  // both false so PinoPlugin does not subscribe to apm:pino:json, making the guard testable.
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

    it('should not emit to capture channel when there are no subscribers', () => {
      // PinoPlugin is disabled (logInjection=false, logCaptureEnabled=false), so the only
      // way hasSubscribers can be true is if external code subscribed — there is none here.
      assert.strictEqual(captureCh.hasSubscribers, false)

      logger.info('no subscriber test')
    })
  })
})
