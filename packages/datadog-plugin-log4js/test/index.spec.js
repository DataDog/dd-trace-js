'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

describe('Plugin', () => {
  let log4js
  let tracer
  let logger
  let spy
  let span

  describe('log4js', () => {
    withVersions('log4js', 'log4js', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
      })

      afterEach(() => {
        return agent.close({ ritmReset: false })
      })

      describe('without configuration', () => {
        beforeEach(() => {
          return agent.load('log4js')
        })

        beforeEach(() => {
          span = tracer.startSpan('test')
          log4js = proxyquire(`../../../versions/log4js@${version}`, {}).get()

          spy = sinon.spy()

          function CustomAppender () {
            return (loggingEvent) => {
              spy(loggingEvent.data && loggingEvent.data.length > 1 ? loggingEvent.data[1] : {})
            }
          }

          log4js.configure({
            appenders: {
              custom: { type: { configure: CustomAppender } }
            },
            categories: {
              default: { appenders: ['custom'], level: 'debug' }
            }
          })

          logger = log4js.getLogger()
        })

        afterEach(() => {
          log4js.shutdown()
        })

        it('should not alter the default behavior', () => {
          const meta = {
            dd: {
              trace_id: span.context().toTraceId(true),
              span_id: span.context().toSpanId()
            }
          }

          tracer.scope().activate(span, () => {
            logger.info('message', meta)

            expect(spy).to.have.been.calledWithMatch(meta)
          })
        })
      })

      describe('with configuration', () => {
        beforeEach(() => {
          return agent.load('log4js', { logInjection: true })
        })

        beforeEach(() => {
          span = tracer.startSpan('test')
          log4js = proxyquire(`../../../versions/log4js@${version}`, {}).get()

          spy = sinon.spy()

          function CustomAppender () {
            return (loggingEvent) => {
              spy(loggingEvent.data && loggingEvent.data.length > 1 ? loggingEvent.data[1] : {})
            }
          }

          log4js.configure({
            appenders: {
              custom: { type: { configure: CustomAppender } }
            },
            categories: {
              default: { appenders: ['custom'], level: 'debug' }
            }
          })

          logger = log4js.getLogger()
        })

        afterEach(() => {
          log4js.shutdown()
        })

        it('should add the trace identifiers to the default logger', () => {
          const meta = {
            dd: {
              trace_id: span.context().toTraceId(true),
              span_id: span.context().toSpanId()
            }
          }

          tracer.scope().activate(span, () => {
            logger.info('message', {})

            expect(spy).to.have.been.calledWithMatch({ dd: meta.dd })
          })
        })

        it('should add the trace identifiers to logger instances', () => {
          const customLogger = log4js.getLogger('custom')

          const meta = {
            dd: {
              trace_id: span.context().toTraceId(true),
              span_id: span.context().toSpanId()
            }
          }

          tracer.scope().activate(span, () => {
            customLogger.info('message', {})

            expect(spy).to.have.been.calledWithMatch({ dd: meta.dd })
          })
        })

        it('should support errors', () => {
          const meta = {
            dd: {
              trace_id: span.context().toTraceId(true),
              span_id: span.context().toSpanId()
            }
          }
          const error = new Error('boom')

          tracer.scope().activate(span, () => {
            logger.error(error, {})

            expect(spy).to.have.been.calledWithMatch({ dd: meta.dd })
          })
        })

        it('should not overwrite any existing "dd" property', () => {
          tracer.scope().activate(span, () => {
            const meta = {
              dd: 'something else'
            }
            logger.info('test', meta)

            expect(spy).to.have.been.calledWithMatch({ dd: 'something else' })
          })
        })

        it('should skip injection without a store', () => {
          expect(() => logger.info('message', {})).to.not.throw()
        })
      })
    })
  })
})
