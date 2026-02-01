'use strict'

const assert = require('node:assert/strict')

const http = require('node:http')
const { inspect } = require('node:util')
const { afterEach, beforeEach, describe, it } = require('mocha')

const semver = require('semver')
const sinon = require('sinon')
const { assertObjectContains } = require('../../../integration-tests/helpers')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

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
      getLogResolve(meta ? meta.dd || meta?.params?.meta?.dd : undefined)
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

  async function setupTest (version, winstonConfiguration) {
    span = tracer.startSpan('test')

    winston = require(`../../../versions/winston@${version}`).get()

    logServer = await createLogServer()

    spy = sinon.spy()

    class Transport extends winston.Transport { }

    if (semver.intersects(version, '>=3')) {
      log = sinon.spy((meta) => spy(meta.dd))
    } else {
      log = sinon.spy((level, msg, meta) => spy(meta.dd))
    }

    Transport.prototype.log = log
    Transport.prototype.name = 'dd'

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
      })

      afterEach(() => {
        if (!winston.configure) {
          winston.remove('dd')
          winston.remove('http')
          winston.add(winston.transports.Console)
        }
      })

      afterEach(() => {
        return agent.close({ ritmReset: false })
      })

      describe('without configuration', () => {
        beforeEach(() => {
          return agent.load('winston')
        })

        beforeEach(() => {
          return setupTest(version)
        })

        afterEach(() => logServer.close())

        it('should not alter the default behavior', () => {
          const meta = {
            dd: {
              trace_id: span.context().toTraceId(true),
              span_id: span.context().toSpanId()
            }
          }

          tracer.scope().activate(span, () => {
            winston.info('message')

            sinon.assert.calledWithMatch(spy, meta.dd)
          })
        })
      })

      describe('with configuration', () => {
        beforeEach(() => {
          return agent.load('winston', { logInjection: true })
        })

        describe('without formatting', () => {
          beforeEach(() => {
            return setupTest(version)
          })

          afterEach(() => logServer.close())

          it('should add the trace identifiers to the default logger', async () => {
            const meta = {
              dd: {
                trace_id: span.context().toTraceId(true),
                span_id: span.context().toSpanId()
              }
            }

            tracer.scope().activate(span, async () => {
              winston.info('message')

              sinon.assert.calledWithMatch(spy, meta.dd)
            })
            assertObjectContains(await logServer.logPromise, meta.dd)
          })

          it('should add the trace identifiers to logger instances', async () => {
            const options = {
              transports: [transport, httpTransport]
            }

            const meta = {
              dd: {
                trace_id: span.context().toTraceId(true),
                span_id: span.context().toSpanId()
              }
            }

            const logger = winston.createLogger
              ? winston.createLogger(options)
              : new winston.Logger(options)

            tracer.scope().activate(span, () => {
              logger.info('message')

              sinon.assert.calledWithMatch(spy, meta.dd)
            })
            assertObjectContains(await logServer.logPromise, meta.dd)
          })

          it('should support errors', async () => {
            const meta = {
              dd: {
                trace_id: span.context().toTraceId(true),
                span_id: span.context().toSpanId()
              }
            }
            const error = new Error('boom')

            tracer.scope().activate(span, () => {
              winston.error(error)

              const index = semver.intersects(version, '>=3') ? 0 : 2
              const record = log.firstCall.args[index]

              assert.ok(record instanceof Error)
              assert.ok(!('dd' in error))
              sinon.assert.calledWithMatch(spy, meta.dd)
            })
            assertObjectContains(await logServer.logPromise, meta.dd)
          })

          if (semver.intersects(version, '>=3')) {
            it('should support sets and getters', async () => {
              const meta = {
                dd: {
                  trace_id: span.context().toTraceId(true),
                  span_id: span.context().toSpanId()
                }
              }
              const set = new Set([1])
              Object.defineProperty(set, 'getter', {
                get () {
                  return this.size
                },
                enumerable: true
              })

              tracer.scope().activate(span, () => {
                winston.log('info', set)

                const record = log.firstCall.args[0]

                assert.ok(record instanceof Set)
                assert.match(inspect(record), /"getter":1,/)
                assert.ok(!('dd' in set))
                sinon.assert.calledWithMatch(spy, meta.dd)
              })
              assertObjectContains(await logServer.logPromise, meta.dd)
            })

            it('should add the trace identifiers when streaming', async () => {
              const logger = winston.createLogger({
                transports: [transport, httpTransport]
              })
              const dd = {
                trace_id: span.context().toTraceId(true),
                span_id: span.context().toSpanId()
              }

              tracer.scope().activate(span, () => {
                logger.write({
                  level: 'info',
                  message: 'message'
                })

                sinon.assert.calledWithMatch(spy, dd)
              })
              assertObjectContains(await logServer.logPromise, dd)
            })
          }

          it('should not overwrite any existing "dd" property', async () => {
            tracer.scope().activate(span, () => {
              const meta = {
                dd: 'something else'
              }
              winston.log('info', 'test', meta)
              assert.strictEqual(meta.dd, 'something else')

              sinon.assert.calledWithMatch(spy, 'something else')
            })
            assertObjectContains(await logServer.logPromise, 'something else')
          })

          // New versions clone the meta object so it's always extensible.
          if (semver.intersects(version, '<3')) {
            it('should not add "dd" property to non-extensible objects', async () => {
              tracer.scope().activate(span, () => {
                const meta = {}
                Object.preventExtensions(meta)
                winston.log('info', 'test', meta)
                assert.strictEqual(meta.dd, undefined)

                sinon.assert.calledWithMatch(spy)
              })
              assert.strictEqual(await logServer.logPromise, undefined)
            })
          }

          it('should skip injection without a store', async () => {
            assert.doesNotThrow(() => winston.info('message'))
          })
        })

        describe('with splat formatting', () => {
          beforeEach(() => {
            if (semver.intersects(version, '>=3')) {
              const splatConfiguration = {
                format: winston.format.combine(...[winston.format.splat(), winston.format.json()])
              }
              return setupTest(version, splatConfiguration)
            } else {
              return setupTest(version)
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
                trace_id: span.context().toTraceId(true),
                span_id: span.context().toSpanId()
              }
            }

            tracer.scope().activate(span, () => {
              winston.info(splatFormmatedLog, extra)

              if (semver.intersects(version, '>=3')) {
                sinon.assert.calledWithMatch(log, {
                  message: interpolatedLog
                })
              } else {
                sinon.assert.calledWithMatch(log, 'info', interpolatedLog)
              }

              sinon.assert.calledWithMatch(spy, meta.dd)
            })
            assertObjectContains(await logServer.logPromise, meta.dd)
          })
        })

        // Only run this test with Winston v3.17.0+ since it uses newer format functions
        if (semver.intersects(version, '>=3.17.0')) {
          describe('with error formatting matching temp.js example', () => {
            let logger

            beforeEach(() => {
              return agent.load('winston', { logInjection: true })
            })

            beforeEach(() => {
              logger = winston.createLogger({
                level: 'info',
                transports: [new winston.transports.Console()],
                format: winston.format.combine(
                  winston.format.errors({ stack: true }),
                  winston.format.prettyPrint()
                )
              })
              spy = sinon.spy(logger.transports[0], 'log')
            })

            afterEach(() => {
              if (spy && spy.restore) {
                spy.restore()
              }
            })

            it('should preserve stack trace when logging Error objects with logInjection enabled', () => {
              const error = new Error('test error with stack')

              tracer.scope().activate(span, () => {
                logger.error(error)

                sinon.assert.called(spy)

                const loggedInfo = spy.firstCall.args[0]
                assert.ok('message' in loggedInfo)

                assert.ok('stack' in loggedInfo)
                assert.strictEqual(typeof loggedInfo.stack, 'string')
                assert.match(loggedInfo.stack, /^Error: test error with stack\n/)

                assert.strictEqual(loggedInfo.message, 'test error with stack')

                assert.ok('dd' in loggedInfo)
                assert.ok('trace_id' in loggedInfo.dd)
                assert.strictEqual(loggedInfo.dd.trace_id, span.context().toTraceId(true))
                assert.ok('span_id' in loggedInfo.dd)
                assert.strictEqual(loggedInfo.dd.span_id, span.context().toSpanId())
              })
            })
          })
        }
      })
    })
  })
})
