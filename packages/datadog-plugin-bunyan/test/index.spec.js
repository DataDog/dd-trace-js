'use strict'

const assert = require('node:assert/strict')
const { Writable } = require('node:stream')
const { inspect } = require('node:util')

const { channel } = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { assertObjectContains } = require('../../../integration-tests/helpers')

const logSubmissionCh = channel('ci:log-submission:log')

describe('Plugin', () => {
  let logger
  let tracer
  let stream
  let span

  function setupTest (version) {
    const bunyan = require(`../../../versions/bunyan@${version}`).get()

    span = tracer.startSpan('test')

    stream = new Writable()
    stream._write = () => {}

    sinon.spy(stream, 'write')

    logger = bunyan.createLogger({ name: 'test', stream })
  }

  describe('bunyan', () => {
    withVersions('bunyan', 'bunyan', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
      })

      afterEach(() => {
        return agent.close()
      })

      describe('without configuration', () => {
        beforeEach(() => {
          return agent.load('bunyan')
        })

        beforeEach(() => {
          setupTest(version)
        })

        it('should not alter the default behavior', () => {
          tracer.scope().activate(span, () => {
            logger.info('message')

            sinon.assert.called(stream.write)

            const record = JSON.parse(stream.write.firstCall.args[0].toString())

            assert.ok(Object.hasOwn(record, 'dd'), `Available keys: ${inspect(Object.keys(record))}`)
          })
        })
      })

      describe('with disabled plugin', () => {
        beforeEach(() => {
          return agent.load('bunyan', { enabled: false })
        })

        beforeEach(() => {
          setupTest(version)
        })

        it('should not publish uncorrelated records for automatic submission', () => {
          const onLog = sinon.spy()
          logSubmissionCh.subscribe(onLog)

          try {
            logger.info('message')
          } finally {
            logSubmissionCh.unsubscribe(onLog)
          }

          sinon.assert.notCalled(onLog)
        })
      })

      describe('with configuration', () => {
        beforeEach(() => {
          return agent.load('bunyan', { logInjection: true })
        })

        beforeEach(() => {
          setupTest(version)
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
          })
        })

        it('should publish correlated records for automatic submission', () => {
          let submission
          const onLog = payload => {
            submission = payload
          }
          logSubmissionCh.subscribe(onLog)

          try {
            tracer.scope().activate(span, () => {
              logger.info('message')
            })
          } finally {
            logSubmissionCh.unsubscribe(onLog)
          }

          const record = JSON.parse(submission.message)
          assert.strictEqual(submission.source, 'bunyan')
          assert.strictEqual(record.dd.trace_id, span.context().toTraceId(true))
          assert.strictEqual(record.dd.span_id, span.context().toSpanId())
        })

        it('should publish correlated raw records for automatic submission', () => {
          const rawStream = new Writable({ objectMode: true })
          rawStream._write = () => {}
          const rawLogger = require(`../../../versions/bunyan@${version}`).get().createLogger({
            name: 'test',
            streams: [{ type: 'raw', stream: rawStream }],
          })
          let submission
          const onLog = payload => {
            submission = payload
          }
          logSubmissionCh.subscribe(onLog)

          try {
            tracer.scope().activate(span, () => {
              rawLogger.info('message')
            })
          } finally {
            logSubmissionCh.unsubscribe(onLog)
          }

          assert.strictEqual(submission.source, 'bunyan')
          assert.strictEqual(submission.message.dd.trace_id, span.context().toTraceId(true))
          assert.strictEqual(submission.message.dd.span_id, span.context().toSpanId())
        })

        it('should not publish serialization-only emissions for automatic submission', () => {
          const onLog = sinon.spy()
          logSubmissionCh.subscribe(onLog)

          try {
            logger._emit({ level: 30, msg: 'message' }, true)
          } finally {
            logSubmissionCh.unsubscribe(onLog)
          }

          sinon.assert.notCalled(onLog)
        })

        it('should not mutate the original record', () => {
          tracer.scope().activate(span, () => {
            const record = { foo: 'bar' }

            logger.info(record)

            sinon.assert.called(stream.write)
            assert.ok(!('dd' in record))
          })
        })

        it('should not inject trace_id or span_id without an active span', () => {
          logger.info('message')

          sinon.assert.called(stream.write)

          const record = JSON.parse(stream.write.firstCall.args[0].toString())

          assert.ok(Object.hasOwn(record, 'dd'), `Available keys: ${inspect(Object.keys(record))}`)
          assert.ok(!('trace_id' in record.dd))
          assert.ok(!('span_id' in record.dd))
        })
      })
    })
  })
})
