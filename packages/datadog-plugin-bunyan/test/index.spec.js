'use strict'

const Writable = require('stream').Writable
const agent = require('../../dd-trace/test/plugins/agent')

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

            expect(stream.write).to.have.been.called

            const record = JSON.parse(stream.write.firstCall.args[0].toString())

            expect(record).to.have.property('dd')
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

            expect(stream.write).to.have.been.called

            const record = JSON.parse(stream.write.firstCall.args[0].toString())

            expect(record.dd).to.deep.include({
              trace_id: span.context().toTraceId(true),
              span_id: span.context().toSpanId()
            })
          })
        })

        it('should not mutate the original record', () => {
          tracer.scope().activate(span, () => {
            const record = { foo: 'bar' }

            logger.info(record)

            expect(stream.write).to.have.been.called
            expect(record).to.not.have.property('dd')
          })
        })

        it('should not inject trace_id or span_id without an active span', () => {
          logger.info('message')

          expect(stream.write).to.have.been.called

          const record = JSON.parse(stream.write.firstCall.args[0].toString())

          expect(record).to.have.property('dd')
          expect(record.dd).to.not.have.property('trace_id')
          expect(record.dd).to.not.have.property('span_id')
        })
      })
    })
  })
})
