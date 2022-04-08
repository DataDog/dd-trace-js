'use strict'

const semver = require('semver')
const agent = require('../../dd-trace/test/plugins/agent')
const http = require('http')
const { expect } = require('chai')
const proxyquire = require('proxyquire').noPreserveCache()

function createLogServer () {
  return new Promise((resolve, reject) => {
    let getLogResolve
    const server = http.createServer((req, res) => {
      if (req.url !== '/loglog') {
        res.end()
        return
      }
      const data = []
      req.on('data', d => data.push(d))
      req.on('end', () => {
        server.log(JSON.parse(Buffer.concat(data)))
        res.end()
      })
    })
    server.log = meta => {
      getLogResolve(meta ? meta.dd || (meta.params && meta.params.meta && meta.params.meta.dd) : undefined)
    }

    server.logPromise = new Promise(resolve => {
      getLogResolve = resolve
    })

    server.listen(0, () => {
      resolve(server)
    })
  })
}

describe('Plugin', () => {
  let winston
  let tracer
  let transport
  let httpTransport
  let log
  let spy
  let span
  let logServer

  async function setup (version, winstonConfiguration) {
    span = tracer.startSpan('test')

    winston = proxyquire(`../../../versions/winston@${version}`, {}).get()

    logServer = await createLogServer()

    spy = sinon.spy()

    class Transport extends winston.Transport {}

    if (semver.intersects(version, '>=3')) {
      log = sinon.spy((meta) => spy(meta.dd))
    } else {
      log = sinon.spy((level, msg, meta) => spy(meta.dd))
    }

    Transport.prototype.log = log

    transport = new Transport()
    httpTransport = new winston.transports.Http({
      host: '127.0.0.1',
      port: logServer.address().port,
      path: '/loglog'
    })

    if (winston.configure) {
      const configureBlock = {
        ...{ transports: [transport, httpTransport] },
        ...winstonConfiguration
      }

      winston.configure(configureBlock)
    } else {
      winston.add(Transport)
      winston.add(winston.transports.Http, {
        host: '127.0.0.1',
        port: logServer.address().port,
        path: '/loglog'
      })
      winston.remove(winston.transports.Console)
    }
  }

  describe('winston', () => {
    withVersions('winston', 'winston', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
        return agent.load('winston')
      })

      afterEach(() => {
        return agent.close({ ritmReset: false })
      })

      describe('without configuration', () => {
        beforeEach(() => {
          return setup(version)
        })

        afterEach(() => logServer.close())

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
            return setup(version)
          })

          afterEach(() => logServer.close())

          it('should add the trace identifiers to the default logger', async () => {
            const meta = {
              dd: {
                trace_id: span.context().toTraceId(),
                span_id: span.context().toSpanId()
              }
            }

            tracer.scope().activate(span, async () => {
              winston.info('message')

              expect(spy).to.have.been.calledWithMatch(meta.dd)
            })
            expect(await logServer.logPromise).to.include(meta.dd)
          })

          it('should add the trace identifiers to logger instances', async () => {
            const options = {
              transports: [transport, httpTransport]
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
            expect(await logServer.logPromise).to.include(meta.dd)
          })

          it('should support errors', async () => {
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
              expect(error).to.not.have.property('dd')
              expect(spy).to.have.been.calledWithMatch(meta.dd)
            })
            expect(await logServer.logPromise).to.include(meta.dd)
          })

          if (semver.intersects(version, '>=3')) {
            it('should add the trace identifiers when streaming', async () => {
              const logger = winston.createLogger({
                transports: [transport, httpTransport]
              })
              const dd = {
                trace_id: span.context().toTraceId(),
                span_id: span.context().toSpanId()
              }

              tracer.scope().activate(span, () => {
                logger.write({
                  level: 'info',
                  message: 'message'
                })

                expect(spy).to.have.been.calledWithMatch(dd)
              })
              expect(await logServer.logPromise).to.include(dd)
            })
          }

          it('should overwrite any existing "dd" property', async () => {
            const meta = {
              dd: {
                trace_id: span.context().toTraceId(),
                span_id: span.context().toSpanId()
              }
            }

            tracer.scope().activate(span, () => {
              const logObj = {
                some: 'data',
                dd: 'something else'
              }
              winston.info(logObj)
              expect(logObj.dd).to.equal('something else')

              expect(spy).to.have.been.calledWithMatch(meta.dd)
            })
            expect(await logServer.logPromise).to.include(meta.dd)
          })

          it('should skip injection without a store', async () => {
            expect(() => winston.info('message')).to.not.throw()
          })
        })

        describe('with splat formatting', () => {
          beforeEach(() => {
            if (semver.intersects(version, '>=3')) {
              const splatConfiguration = {
                format: winston.format.combine(...[winston.format.splat(), winston.format.json()])
              }
              return setup(version, splatConfiguration)
            } else {
              return setup(version)
            }
          })

          afterEach(() => logServer.close())

          it('should ensure interpolated logs are persisted', async () => {
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
            expect(await logServer.logPromise).to.include(meta.dd)
          })
        })
      })
    })
  })
})
