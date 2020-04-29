'use strict'

const Writable = require('stream').Writable
const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

wrapIt()

describe('Plugin', () => {
  let logger
  let tracer
  let stream
  let span

  function setup (version) {
    const pino = require(`../../../versions/pino@${version}`).get()

    span = tracer.startSpan('test')

    stream = new Writable()
    stream._write = () => {}

    sinon.spy(stream, 'write')

    logger = pino(stream)
  }

  describe('pino', () => {
    withVersions(plugin, 'pino', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
        return agent.load('pino')
      })

      afterEach(() => {
        return agent.close()
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
            expect(record).to.have.deep.property('msg', 'message')
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

            expect(record).to.have.deep.property('msg', 'message')
          })
        })

        it('should support errors', () => {
          tracer.scope().activate(span, () => {
            const error = new Error('boom')

            logger.info(error)

            const record = JSON.parse(stream.write.firstCall.args[0].toString())

            expect(record).to.have.property('msg', error.message)
            expect(record).to.have.property('type', 'Error')
            expect(record).to.have.property('stack', error.stack)
          })
        })

        it('should not alter the original record', () => {
          tracer.scope().activate(span, () => {
            const record = {
              foo: 'bar'
            }

            logger.info(record)

            expect(record).to.not.have.property('dd')
          })
        })
      })
    })
  })
})
