'use strict'

const assert = require('node:assert/strict')
const { Writable } = require('node:stream')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { assertObjectContains } = require('../../../integration-tests/helpers')

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
        return agent.close({ ritmReset: false })
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

            assert.ok(Object.hasOwn(record, 'dd'))
          })
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
              span_id: span.context().toSpanId()
            })
          })
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

          assert.ok(Object.hasOwn(record, 'dd'))
          assert.ok(!('trace_id' in record.dd))
          assert.ok(!('span_id' in record.dd))
        })
      })
    })
  })
})
