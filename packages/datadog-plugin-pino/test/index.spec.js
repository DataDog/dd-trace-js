'use strict'

const assert = require('node:assert/strict')
const { Writable } = require('node:stream')

const { channel } = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const semver = require('semver')
const sinon = require('sinon')

const { NODE_MAJOR } = require('../../../version')
const agent = require('../../dd-trace/test/plugins/agent')
const { withExports, withVersions } = require('../../dd-trace/test/setup/mocha')
const { assertObjectContains } = require('../../../integration-tests/helpers')

const logSubmissionCh = channel('ci:log-submission:log')

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
        return agent.close()
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

        describe('with disabled plugin', () => {
          beforeEach(async () => {
            tracer = await agent.load('pino', { enabled: false })
          })

          it('should not submit logs', function () {
            const submittedLogs = []
            const onLogSubmission = payload => {
              submittedLogs.push(payload)
            }
            logSubmissionCh.subscribe(onLogSubmission)

            try {
              setupTest()

              if (!logger) {
                this.skip()
              }

              logger.info('message')
            } finally {
              logSubmissionCh.unsubscribe(onLogSubmission)
            }

            assert.strictEqual(submittedLogs.length, 0)
            sinon.assert.called(stream.write)
          })
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
            let submittedLog
            const onLogSubmission = payload => {
              submittedLog = payload
            }
            logSubmissionCh.subscribe(onLogSubmission)
            setupTest()

            tracer.scope().activate(span, () => {
              try {
                logger.info('message')
              } finally {
                logSubmissionCh.unsubscribe(onLogSubmission)
              }

              sinon.assert.called(stream.write)

              const record = JSON.parse(stream.write.firstCall.args[0].toString())

              assertObjectContains(record.dd, {
                trace_id: span.context().toTraceId(true),
                span_id: span.context().toSpanId(),
              })

              assert.ok('msg' in record)
              assert.deepStrictEqual(record.msg, 'message')

              assert.strictEqual(submittedLog.source, 'pino')
              assert.deepStrictEqual(JSON.parse(submittedLog.message), record)
            })
          })

          it('should submit from logger instances created while the plugin is disabled', () => {
            let submittedLog
            const onLogSubmission = payload => {
              submittedLog = payload
            }

            tracer.use('pino', false)
            logSubmissionCh.subscribe(onLogSubmission)
            setupTest()
            tracer.use('pino', { enabled: true, logInjection: true })

            tracer.scope().activate(span, () => {
              try {
                logger.info('message')
              } finally {
                tracer.use('pino', false)
                logSubmissionCh.unsubscribe(onLogSubmission)
              }
            })

            const record = JSON.parse(stream.write.firstCall.args[0].toString())

            assertObjectContains(record.dd, {
              trace_id: span.context().toTraceId(true),
              span_id: span.context().toSpanId(),
            })
            assert.strictEqual(submittedLog.source, 'pino')
            assert.deepStrictEqual(JSON.parse(submittedLog.message), record)
          })

          if (version === '2.0.0') {
            it('should submit records after changing the level on legacy logger instances', () => {
              let submittedLog
              const onLogSubmission = payload => {
                submittedLog = payload
              }
              logSubmissionCh.subscribe(onLogSubmission)
              setupTest()

              logger.level = 'debug'
              try {
                logger.debug('message')
              } finally {
                logSubmissionCh.unsubscribe(onLogSubmission)
              }

              const record = JSON.parse(stream.write.firstCall.args[0].toString())

              assert.strictEqual(record.msg, 'message')
              assert.strictEqual(submittedLog.source, 'pino')
              assert.deepStrictEqual(JSON.parse(submittedLog.message), record)
            })
          }

          if (semver.intersects(version, '>=3 <5')) {
            it('should submit records from configured custom level methods', () => {
              let submittedLog
              const onLogSubmission = payload => {
                submittedLog = payload
              }
              logSubmissionCh.subscribe(onLogSubmission)
              setupTest({ level: 'custom', levelVal: 35 })

              try {
                logger.custom('message')
              } finally {
                logSubmissionCh.unsubscribe(onLogSubmission)
              }

              const record = JSON.parse(stream.write.firstCall.args[0].toString())

              assert.strictEqual(record.msg, 'message')
              assert.strictEqual(record.level, 35)
              assert.strictEqual(submittedLog.source, 'pino')
              assert.deepStrictEqual(JSON.parse(submittedLog.message), record)
            })
          }

          it('should submit records from child logger instances', () => {
            let submittedLog
            const onLogSubmission = payload => {
              submittedLog = payload
            }
            logSubmissionCh.subscribe(onLogSubmission)
            setupTest()

            const child = logger.child({ child: true })
            tracer.scope().activate(span, () => {
              try {
                child.info('message')
              } finally {
                logSubmissionCh.unsubscribe(onLogSubmission)
              }
            })

            const record = JSON.parse(stream.write.firstCall.args[0].toString())

            assert.strictEqual(record.child, true)
            assertObjectContains(record.dd, {
              trace_id: span.context().toTraceId(true),
              span_id: span.context().toSpanId(),
            })
            assert.strictEqual(submittedLog.source, 'pino')
            assert.deepStrictEqual(JSON.parse(submittedLog.message), record)
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

          it('should not overwrite a caller-supplied dd field', () => {
            let submittedLog
            const onLogSubmission = payload => {
              submittedLog = payload
            }
            logSubmissionCh.subscribe(onLogSubmission)
            setupTest()

            tracer.scope().activate(span, () => {
              try {
                logger.info({ dd: { custom: 'value' } }, 'message')
              } finally {
                logSubmissionCh.unsubscribe(onLogSubmission)
              }

              sinon.assert.called(stream.write)

              const record = JSON.parse(stream.write.firstCall.args[0].toString())

              assert.deepStrictEqual(record.dd, { custom: 'value' })
              assert.strictEqual(submittedLog.source, 'pino')
              assert.deepStrictEqual(JSON.parse(submittedLog.message).dd, { custom: 'value' })
            })
          })

          it('should not submit records when the destination throws', () => {
            const pino = getExport()
            const failingStream = new Writable()
            const submittedLogs = []
            const onLogSubmission = payload => {
              submittedLogs.push(payload)
            }
            sinon.stub(failingStream, 'write').throws(new Error('boom'))
            logSubmissionCh.subscribe(onLogSubmission)

            try {
              logger = pino({}, failingStream)
              assert.throws(() => logger.info('message'), { message: 'boom' })
            } finally {
              logSubmissionCh.unsubscribe(onLogSubmission)
            }

            assert.strictEqual(submittedLogs.length, 0)
          })

          if (semver.intersects(version, '>=9')) {
            it('should not wrap streamWrite hooks without a log submission subscriber', () => {
              const pino = getExport()
              const streamWrite = sinon.spy(line => line.replace('sensitive-api-key', '[Redacted]'))

              setupTest({ hooks: { streamWrite } })
              logger.info('sensitive-api-key')

              const record = JSON.parse(stream.write.firstCall.args[0].toString())

              assert.strictEqual(logger[pino.symbols.hooksSym].streamWrite, streamWrite)
              assert.strictEqual(record.msg, '[Redacted]')
            })

            it('should submit the final record after streamWrite hooks', () => {
              let submittedLog
              /** @param {{ source: string, message: string }} payload */
              const onLogSubmission = payload => {
                submittedLog = payload
              }
              logSubmissionCh.subscribe(onLogSubmission)

              setupTest({
                hooks: {
                  /** @param {string} line */
                  streamWrite (line) {
                    return line.replace('sensitive-api-key', '[Redacted]')
                  },
                },
              })

              tracer.scope().activate(span, () => {
                try {
                  logger.info('sensitive-api-key')
                } finally {
                  logSubmissionCh.unsubscribe(onLogSubmission)
                }
              })

              const record = JSON.parse(stream.write.firstCall.args[0].toString())

              assert.strictEqual(record.msg, '[Redacted]')
              assert.deepStrictEqual(JSON.parse(submittedLog.message), record)
            })

            it('should not submit non-JSON streamWrite output', () => {
              const submittedLogs = []
              const onLogSubmission = payload => {
                submittedLogs.push(payload)
              }
              logSubmissionCh.subscribe(onLogSubmission)

              setupTest({
                hooks: {
                  /** @param {string} line */
                  streamWrite (line) {
                    return line.includes('invalid') ? `prefix ${line}` : line
                  },
                },
              })

              try {
                logger.info('invalid')
                logger.info('valid')
              } finally {
                logSubmissionCh.unsubscribe(onLogSubmission)
              }

              assert.match(stream.write.firstCall.args[0].toString(), /^prefix /)
              assert.strictEqual(submittedLogs.length, 1)
              assert.strictEqual(JSON.parse(submittedLogs[0].message).msg, 'valid')
            })

            it('should not submit transformed records when the destination throws', () => {
              const pino = getExport()
              const failingStream = new Writable()
              const submittedLogs = []
              const onLogSubmission = payload => {
                submittedLogs.push(payload)
              }
              sinon.stub(failingStream, 'write').throws(new Error('boom'))
              logSubmissionCh.subscribe(onLogSubmission)

              try {
                logger = pino({ hooks: { streamWrite: line => line } }, failingStream)
                assert.throws(() => logger.info('message'), { message: 'boom' })
              } finally {
                logSubmissionCh.unsubscribe(onLogSubmission)
              }

              assert.strictEqual(submittedLogs.length, 0)
            })
          }

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
      })
    })
  })
})
