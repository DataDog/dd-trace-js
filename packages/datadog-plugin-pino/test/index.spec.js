'use strict'

const assert = require('node:assert/strict')
const { Writable } = require('node:stream')

const { afterEach, beforeEach, describe, it } = require('mocha')
const semver = require('semver')
const sinon = require('sinon')

const { NODE_MAJOR } = require('../../../version')
const agent = require('../../dd-trace/test/plugins/agent')
const { withExports, withVersions } = require('../../dd-trace/test/setup/mocha')
const { assertObjectContains } = require('../../../integration-tests/helpers')

describe('Plugin', () => {
  let logger
  let tracer
  let stream
  let span

  describe('pino', () => {
    withVersions('pino', 'pino', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
      })

      afterEach(() => {
        return agent.close({ ritmReset: false })
      })

      withExports('pino', version, ['default', 'pino'], '>=6.8.0', getExport => {
        function setupTest (options = {}) {
          const pino = getExport()

          span = tracer.startSpan('test')

          stream = new Writable()
          stream._write = () => {}

          sinon.spy(stream, 'write')

          if (semver.intersects(version, '>=8') && options.prettyPrint) {
            delete options.prettyPrint // deprecated

            // pino-pretty uses `on-exit-leak-free` and that adds a listener to process.
            process.setMaxListeners(process.getMaxListeners() + 1)
            const pretty = require('../../../versions/pino-pretty@8.0.0').get()

            stream = pretty().pipe(stream)
          } else if (semver.intersects(version, '>=5 <8') && options.prettyPrint) {
            // pino 5-7 supports prettyPrint internally by calling require('pino-pretty').
            // In this test environment, that resolves to pino-pretty@8 which exports an
            // abstractTransport-based Transform stream — incompatible with pino 5-7's
            // expectation of a sync factory function. pino-pretty@8 also creates a
            // SonicBoom (writing to stdout) that registers with on-exit-leak-free,
            // leaving async resources that prevent mocha from exiting after the test.
            // Provide pino-pretty@3 via the `prettifier` option so pino uses its
            // synchronous factory interface and avoids the leaked resources.
            options.prettifier = require('../../../versions/pino-pretty@3.0.0').get()
          }

          logger = pino(options, stream)
        }

        describe('without configuration', () => {
          beforeEach(() => {
            return agent.load('pino')
          })

          beforeEach(function () {
            setupTest()

            if (!logger) {
              this.skip()
            }
          })

          it('should not alter the default behavior', () => {
            tracer.scope().activate(span, () => {
              logger.info('message')

              sinon.assert.called(stream.write)

              const record = JSON.parse(stream.write.firstCall.args[0].toString())

              assert.ok('dd' in record)
              assert.ok('msg' in record)
              assert.deepStrictEqual(record.msg, 'message')
            })
          })

          if (semver.intersects(version, '>=5')) {
            it('should not alter the default behavior with pretty print', () => {
              setupTest({ prettyPrint: true })

              tracer.scope().activate(span, () => {
                logger.info('message')

                sinon.assert.called(stream.write)

                const record = stream.write.firstCall.args[0].toString()

                assert.match(record, new RegExp(`trace_id\\W+?${span.context().toTraceId(true)}`))
                assert.match(record, new RegExp(`span_id\\W+?${span.context().toSpanId()}`))
                assert.match(record, /message/)
              })
            })
          }
        })

        describe('with configuration', () => {
          beforeEach(() => {
            return agent.load('pino', { logInjection: true })
          })

          beforeEach(function () {
            setupTest()

            if (!logger) {
              this.skip()
            }
          })

          it('should add the trace identifiers to logger instances', () => {
            tracer.scope().activate(span, () => {
              logger.info('message')

              sinon.assert.called(stream.write)

              const record = JSON.parse(stream.write.firstCall.args[0].toString())

              assertObjectContains(record.dd, {
                trace_id: span.context().toTraceId(true),
                span_id: span.context().toSpanId(),
              })

              assert.ok('msg' in record)
              assert.deepStrictEqual(record.msg, 'message')
            })
          })

          it('should support errors', () => {
            tracer.scope().activate(span, () => {
              const error = new Error('boom')

              logger.info(error)

              const record = JSON.parse(stream.write.firstCall.args[0].toString())

              if (record.err) { // pino >=7
                assert.ok('message' in record.err)
                assert.strictEqual(record.err.message, error.message)
                assert.ok('type' in record.err)
                assert.strictEqual(record.err.type, 'Error')
                assert.ok('stack' in record.err)
                assert.strictEqual(record.err.stack, error.stack)
              } else { // pino <7
                assert.ok('msg' in record)
                assert.strictEqual(record.msg, error.message)
                // ** TODO ** add this back once we fix it
                if (NODE_MAJOR < 21) {
                  assert.ok('type' in record)
                  assert.strictEqual(record.type, 'Error')
                  assert.ok('stack' in record)
                  assert.strictEqual(record.stack, error.stack)
                }
              }
            })
          })

          it('should not alter the original record', () => {
            tracer.scope().activate(span, () => {
              const record = {
                foo: 'bar',
              }

              logger.info(record)

              assert.ok(!('dd' in record))
            })
          })

          it('should not inject trace_id or span_id without an active span', () => {
            logger.info('message')

            sinon.assert.called(stream.write)

            const record = JSON.parse(stream.write.firstCall.args[0].toString())

            assert.ok('dd' in record)
            assert.ok(!('trace_id' in record.dd))
            assert.ok(!('span_id' in record.dd))
            assert.ok('msg' in record)
            assert.deepStrictEqual(record.msg, 'message')
          })

          if (semver.intersects(version, '>=5.14.0')) {
            it('should not alter pino mixin behavior', () => {
              const opts = { mixin: () => ({ addedMixin: true }) }

              sinon.spy(opts, 'mixin')

              setupTest(opts)

              tracer.scope().activate(span, () => {
                logger.info('message')

                sinon.assert.called(opts.mixin)

                sinon.assert.called(stream.write)

                const record = JSON.parse(stream.write.firstCall.args[0].toString())

                assertObjectContains(record.dd, {
                  trace_id: span.context().toTraceId(true),
                  span_id: span.context().toSpanId(),
                })

                assert.ok('msg' in record)
                assert.deepStrictEqual(record.msg, 'message')
                assert.ok('addedMixin' in record)
                assert.deepStrictEqual(record.addedMixin, true)
              })
            })
          }

          // TODO: test with a version matrix against pino. externals.js doesn't allow that
          //       and we cannot control the version of pino-pretty internally required by pino
          if (semver.intersects(version, '>=5')) {
            it('should add the trace identifiers to logger instances with pretty print', () => {
              setupTest({ prettyPrint: true })

              tracer.scope().activate(span, () => {
                logger.info('message')

                sinon.assert.called(stream.write)

                const record = stream.write.firstCall.args[0].toString()

                assert.match(record, new RegExp(`trace_id\\W+?${span.context().toTraceId(true)}`))
                assert.match(record, new RegExp(`span_id\\W+?${span.context().toSpanId()}`))

                assert.match(record, /message/)
              })
            })
          }
        })

        if (semver.intersects(version, '>=5.14.0')) {
          describe('log capture channel (apm:pino:json)', () => {
            beforeEach(() => {
              return agent.load('pino')
            })

            beforeEach(function () {
              setupTest()

              if (!logger) {
                this.skip()
              }
            })

            it('should emit a complete JSON record including pid, hostname, level, time, msg', (done) => {
              const { channel } = require('dc-polyfill')
              const captureCh = channel('apm:pino:json')
              let captured
              const sub = (payload) => { captured = payload }
              captureCh.subscribe(sub)

              logger.info('hello capture')

              setImmediate(() => {
                captureCh.unsubscribe(sub)
                assert.ok(captured, 'capture channel should have fired')
                const record = JSON.parse(captured.json)
                assert.ok(record.pid, 'should have pid')
                assert.ok(record.hostname, 'should have hostname')
                assert.ok(record.time, 'should have time')
                assert.strictEqual(record.msg, 'hello capture')
                done()
              })
            })
          })
        }

        if (semver.intersects(version, '<5.14.0')) {
          describe('log capture channel (apm:pino:json) for <5.14.0', () => {
            beforeEach(() => {
              return agent.load('pino')
            })

            beforeEach(function () {
              setupTest()

              if (!logger) {
                this.skip()
              }
            })

            it('should emit a complete JSON record for pino <5.14', (done) => {
              const { channel } = require('dc-polyfill')
              const captureCh = channel('apm:pino:json')
              let captured
              const sub = (payload) => { captured = payload }
              captureCh.subscribe(sub)

              logger.info('hello old pino')

              setImmediate(() => {
                captureCh.unsubscribe(sub)
                assert.ok(captured, 'capture channel should have fired for <5.14')
                const record = JSON.parse(captured.json)
                assert.ok(record.time, 'should have time')
                assert.strictEqual(record.msg, 'hello old pino')
                done()
              })
            })

            it('should include holder from apm:pino:log in the capture payload for <5.14', (done) => {
              const { channel } = require('dc-polyfill')
              const captureCh = channel('apm:pino:json')
              let captured
              const sub = (payload) => { captured = payload }
              captureCh.subscribe(sub)

              const activeSpan = tracer.startSpan('capture-holder-test')
              tracer.scope().activate(activeSpan, () => {
                logger.info('holder test')
              })
              activeSpan.finish()

              setImmediate(() => {
                captureCh.unsubscribe(sub)
                assert.ok(captured, 'capture channel should have fired')
                // wrapAsJson passes payload.holder (set by log_plugin apm:pino:log subscription)
                // so log_plugin can enrich the captured record with dd trace context
                assert.ok(captured.holder, 'holder should be present in capture payload')
                assert.ok(captured.holder.dd, 'holder.dd should contain trace context')
                done()
              })
            })

            it('should not publish to capture channel when there are no subscribers', (done) => {
              // agent.load() defaults to logInjection:true, which activates the apm:pino:json
              // subscription. Reload with both disabled so the channel has no subscribers,
              // letting us test the captureCh.hasSubscribers guard in wrapAsJson.
              agent.reload('pino', { logInjection: false, logCaptureEnabled: false })

              const { channel } = require('dc-polyfill')
              const captureCh = channel('apm:pino:json')
              assert.strictEqual(captureCh.hasSubscribers, false)

              // Logging should still succeed — the captureCh.hasSubscribers guard in wrapAsJson
              // prevents any publish attempt when no one is listening
              logger.info('no subscriber test')

              setImmediate(() => {
                done()
              })
            })
          })
        }
      })
    })
  })
})
