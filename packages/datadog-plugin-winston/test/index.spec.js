'use strict'

const semver = require('semver')
const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

wrapIt()

describe('Plugin', () => {
  let winston
  let tracer
  let transport
  let span

  function setup (version, winstonConfiguration) {
    span = tracer.startSpan('test')

    winston = require(`../../../versions/winston@${version}`).get()

    class Transport extends winston.Transport {}

    Transport.prototype.log = sinon.spy()

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
        return agent.load(plugin, 'winston')
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

            if (semver.intersects(version, '>=3')) {
              expect(transport.log).to.not.have.been.calledWithMatch(meta)
            } else {
              expect(transport.log).to.not.have.been.calledWithMatch('info', 'message', meta)
            }
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

              if (semver.intersects(version, '>=3')) {
                expect(transport.log).to.have.been.calledWithMatch(meta)
              } else {
                expect(transport.log).to.have.been.calledWithMatch('info', 'message', meta)
              }
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

              if (semver.intersects(version, '>=3')) {
                expect(transport.log).to.have.been.calledWithMatch(meta)
              } else {
                expect(transport.log).to.have.been.calledWithMatch('info', 'message', meta)
              }
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

                expect(transport.log).to.have.been.calledWithMatch({
                  dd: {
                    trace_id: span.context().toTraceId(),
                    span_id: span.context().toSpanId()
                  }
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
                meta['message'] = interpolatedLog

                expect(transport.log).to.have.been.calledWithMatch(meta)
              } else {
                expect(transport.log).to.have.been.calledWithMatch('info', interpolatedLog, meta)
              }
            })
          })
        })
      })
    })
  })
})
