'use strict'

const Writable = require('stream').Writable
const agent = require('../../dd-trace/test/plugins/agent')

describe('Plugin', () => {
  let logger
  let tracer
  let stream
  let span

  function setup (version) {
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
        return agent.load('bunyan')
      })

      afterEach(() => {
        return agent.close({ ritmReset: false })
      })

      describe('without configuration', () => {
        beforeEach(() => {
          setup(version)
        })

        it('should not alter the default behavior', () => {
          tracer.scope().activate(span, () => {
            logger.info('message')

            expect(stream.write).to.have.been.called

            const record = JSON.parse(stream.write.firstCall.args[0].toString())

            expect(record).to.not.have.property('dd')
          })
        })
      })

      describe('with configuration', () => {
        beforeEach(() => {
          tracer._tracer._logInjection = true
          setup(version)
        })

        it('should add the trace identifiers to logger instances', () => {
          tracer.scope().activate(span, () => {
            logger.info('message')

            expect(stream.write).to.have.been.called

            const record = JSON.parse(stream.write.firstCall.args[0].toString())

            expect(record.dd).to.deep.include({
              trace_id: span.context().toTraceId(),
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

        it('should skip injection without an active span', () => {
          logger.info('message')

          expect(stream.write).to.have.been.called

          const record = JSON.parse(stream.write.firstCall.args[0].toString())

          expect(record).to.not.have.property('dd')
        })
      })
    })
  })
})
