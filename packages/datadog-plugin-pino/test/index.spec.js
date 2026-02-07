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

          // TODO: test with a version matrix against pino. externals.json doesn't allow that
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
      })
    })
  })
})
