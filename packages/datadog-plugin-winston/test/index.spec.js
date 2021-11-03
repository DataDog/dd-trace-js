'use strict'

const semver = require('semver')
const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

describe('Plugin', () => {
  let winston
  let tracer
  let transport
  let log
  let spy
  let span

  function setup (version, winstonConfiguration) {
    span = tracer.startSpan('test')

    winston = require(`../../../versions/winston@${version}`).get()

    spy = sinon.spy()

    class Transport extends winston.Transport {}

    if (semver.intersects(version, '>=3')) {
      log = sinon.spy((meta) => spy(meta.dd))
    } else {
      log = sinon.spy((level, msg, meta) => spy(meta.dd))
    }

    Transport.prototype.log = log

    transport = new Transport()

    if (winston.configure) {
      const configureBlock = {
        ...{ transports: [transport] },
        ...winstonConfiguration
      }

      winston.configure(configureBlock)
    } else {
      winston.add(Transport)
      winston.remove(winston.transports.Console)
    }
  }

  describe('winston', () => {
    withVersions(plugin, 'winston', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
        return agent.load('winston')
      })

      afterEach(() => {
        return agent.close()
      })

      describe('without configuration', () => {
        beforeEach(() => {
          setup(version)
        })

        it('should not alter the default behavior', () => {
          const meta = {
            dd: {
              trace_id: span.context().toTraceId(),
              span_id: span.context().toSpanId()
            }
          }

          tracer.scope().activate(span, () => {
            winston.info('message')

            expect(spy).to.not.have.been.calledWithMatch(meta.dd)
          })
        })
      })

      describe('with configuration', () => {
        beforeEach(() => {
          tracer._tracer._logInjection = true
        })

        describe('without formatting', () => {
          beforeEach(() => {
            setup(version)
          })

          it('should add the trace identifiers to the default logger', () => {
            const meta = {
              dd: {
                trace_id: span.context().toTraceId(),
                span_id: span.context().toSpanId()
              }
            }

            tracer.scope().activate(span, () => {
              winston.info('message')

              expect(spy).to.have.been.calledWithMatch(meta.dd)
            })
          })

          it('should add the trace identifiers to logger instances', () => {
            const options = {
              transports: [transport]
            }

            const meta = {
              dd: {
                trace_id: span.context().toTraceId(),
                span_id: span.context().toSpanId()
              }
            }

            const logger = winston.createLogger
              ? winston.createLogger(options)
              : new winston.Logger(options)

            tracer.scope().activate(span, () => {
              logger.info('message')

              expect(spy).to.have.been.calledWithMatch(meta.dd)
            })
          })

          it('should support errors', () => {
            const meta = {
              dd: {
                trace_id: span.context().toTraceId(),
                span_id: span.context().toSpanId()
              }
            }

            const error = new Error('boom')

            tracer.scope().activate(span, () => {
              winston.error(error)

              const index = semver.intersects(version, '>=3') ? 0 : 2
              const record = log.firstCall.args[index]

              expect(record).to.be.an('error')
              expect(record).to.not.have.property('dd')
              expect(spy).to.have.been.calledWithMatch(meta.dd)
            })
          })

          if (semver.intersects(version, '>=3')) {
            it('should add the trace identifiers when streaming', () => {
              const logger = winston.createLogger({
                transports: [transport]
              })

              tracer.scope().activate(span, () => {
                logger.write({
                  level: 'info',
                  message: 'message'
                })

                expect(spy).to.have.been.calledWithMatch({
                  trace_id: span.context().toTraceId(),
                  span_id: span.context().toSpanId()
                })
              })
            })
          }
        })

        describe('with splat formatting', () => {
          beforeEach(() => {
            if (semver.intersects(version, '>=3')) {
              const splatConfiguration = {
                format: winston.format.combine(...[winston.format.splat(), winston.format.json()])
              }
              setup(version, splatConfiguration)
            } else {
              setup(version)
            }
          })

          it('should ensure interpolated logs are persisted', () => {
            const base = 'test'
            const extra = 'message'
            const interpolatedLog = base + ` ${extra}`
            const splatFormmatedLog = base + ' %s'

            const meta = {
              dd: {
                trace_id: span.context().toTraceId(),
                span_id: span.context().toSpanId()
              }
            }

            tracer.scope().activate(span, () => {
              winston.info(splatFormmatedLog, extra)

              if (semver.intersects(version, '>=3')) {
                expect(log).to.have.been.calledWithMatch({
                  message: interpolatedLog
                })
              } else {
                expect(log).to.have.been.calledWithMatch('info', interpolatedLog)
              }

              expect(spy).to.have.been.calledWithMatch(meta.dd)
            })
          })
        })
      })
    })
  })
})
