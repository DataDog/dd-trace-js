'use strict'

const assert = require('node:assert/strict')
const { AsyncLocalStorage } = require('node:async_hooks')

const axios = require('axios')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const semver = require('semver')
const sinon = require('sinon')

const { ERROR_MESSAGE } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

describe('Plugin', () => {
  let tracer
  let restify
  let appListener

  describe('restify', () => {
    withVersions('restify', 'restify', version => {
      const pkgVersion = require(`../../../versions/restify@${version}`).version()

      // restify <4 fails to load (its `dtrace-provider` native dep has no prebuilt binding), and 7.x-9.x crash
      // on load on Node >=18 (they assign the now getter-only `IncomingMessage#closed`). Skip those; the
      // remaining majors (4-6, 10+) load and run against this suite.
      if (semver.intersects(pkgVersion, '<4.0.0') || semver.intersects(pkgVersion, '>=7.0.0 <10.0.0')) return

      beforeEach(() => {
        tracer = require('../../dd-trace')
        restify = require(`../../../versions/restify@${version}`).get()
      })

      afterEach(() => {
        appListener.close()
      })

      describe('without configuration', () => {
        before(() => agent.load(['restify', 'find-my-way', 'http'], [{}, {}, { client: false }]))

        after(() => agent.close())

        it('should do automatic instrumentation', done => {
          const server = restify.createServer()

          appListener = server.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].name, 'restify.request')
                assert.strictEqual(traces[0][0].service, 'test')
                assert.strictEqual(traces[0][0].type, 'web')
                assert.strictEqual(traces[0][0].resource, 'GET')
                assert.strictEqual(traces[0][0].meta['span.kind'], 'server')
                assert.strictEqual(traces[0][0].meta['http.url'], `http://localhost:${port}/user`)
                assert.strictEqual(traces[0][0].meta['http.method'], 'GET')
                assert.strictEqual(traces[0][0].meta['http.status_code'], '404')
                assert.strictEqual(traces[0][0].meta.component, 'restify')
                assert.strictEqual(traces[0][0].meta['_dd.integration'], 'restify')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/user`)
              .catch(() => {})
          })
        })

        it('should support routing', done => {
          const server = restify.createServer()

          server.get('/user/:id', (req, res, next) => {
            res.send(200)
            return next()
          })

          appListener = server.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].resource, 'GET /user/:id')
                assert.strictEqual(traces[0][0].meta['http.url'], `http://localhost:${port}/user/123`)
                assert.strictEqual(traces[0][0].meta.component, 'restify')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/user/123`)
              .catch(done)
          })
        })

        // restify added async route handler/middleware support in 7.x; older majors never await the
        // returned promise, so the request hangs. Only assert async routing where the feature exists.
        it('should support routing with async functions and middleware', function (done) {
          if (!semver.intersects(pkgVersion, '>=7')) return this.skip()

          const server = restify.createServer()

          server.get(
            '/user/:id',
            async function middleware () {},
            async function handler (req, res) {
              res.send('hello, ' + req.params.id)
            }
          )

          appListener = server.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].resource, 'GET /user/:id')
                assert.strictEqual(traces[0][0].meta['http.url'], `http://localhost:${port}/user/123`)
                assert.strictEqual(traces[0][0].meta.component, 'restify')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/user/123`)
              .catch(done)
          })
        })

        it('should route without producing any warnings', function (done) {
          if (!semver.intersects(pkgVersion, '>=7')) return this.skip()

          const warningSpy = sinon.spy((_, msg) => {
            // eslint-disable-next-line no-console
            console.error(`route called with warning: ${msg}`)
          })

          const server = restify.createServer({
            log: {
              trace: () => {},
              warn: warningSpy,
            },
          })

          server.get(
            '/user/:id',
            async function middleware () {},
            async function handler (req, res) {
              res.send('hello, ' + req.params.id)
            }
          )

          appListener = server.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                sinon.assert.notCalled(warningSpy)
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/user/123`)
              .catch(done)
          })
        })

        it('should run handlers in the request scope', done => {
          const server = restify.createServer()
          const interval = setInterval(() => {
            if (next) {
              next()
              clearInterval(interval)
            }
          })

          let next

          server.pre((req, res, next) => {
            assert.notStrictEqual(tracer.scope().active(), null)
            next()
          })

          // break the async context
          server.use((req, res, _next) => {
            next = _next
          })

          server.use((req, res, next) => {
            assert.notStrictEqual(tracer.scope().active(), null)
            next()
          })

          server.get('/user', (req, res, next) => {
            assert.notStrictEqual(tracer.scope().active(), null)
            res.send(200)
            next()
            done()
          })

          appListener = server.listen(0, 'localhost', () => {
            const port = appListener.address().port

            axios
              .get(`http://localhost:${port}/user`)
              .catch(done)
          })
        })

        it('should support array middleware', done => {
          const server = restify.createServer()

          server.get('/user/:id', [(req, res, next) => {
            res.send(200)
            return next()
          }])

          appListener = server.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].resource, 'GET /user/:id')
                assert.strictEqual(traces[0][0].meta['http.url'], `http://localhost:${port}/user/123`)
                assert.strictEqual(traces[0][0].meta.component, 'restify')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/user/123`)
              .catch(done)
          })
        })

        it('should keep user stores untouched', done => {
          const server = restify.createServer()
          const storage = new AsyncLocalStorage()
          const store = {}

          server.use((req, res, next) => {
            storage.run(store, () => next())
          })

          server.get('/user', (req, res, next) => {
            try {
              assert.strictEqual(storage.getStore(), store)
              res.end()
              done()
            } catch (e) {
              res.end()
              done(e)
            }
          })

          appListener = server.listen(0, 'localhost', () => {
            const port = appListener.address().port

            axios
              .get(`http://localhost:${port}/user`)
              .catch(done)
          })
        })

        it('should allow handleUncaughtException', done => {
          const server = restify.createServer({
            handleUncaughtExceptions: true,
            log: {
              trace: function () {},
              warn: function () {},
            },
          })
          server.on('uncaughtException', function (req, res, route, err) {
            res.send(599)
          })

          server.get('/error', [(req, res, next) => {
            throw new Error('uncaught')
          }])

          appListener = server.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].resource, 'GET /error')
                assert.strictEqual(traces[0][0].meta[ERROR_MESSAGE], 'uncaught')
                assert.strictEqual(traces[0][0].meta['http.url'], `http://localhost:${port}/error`)
                assert.strictEqual(traces[0][0].meta['http.status_code'], '599')
                assert.strictEqual(traces[0][0].meta.component, 'restify')
              }, { timeoutMs: 12000 }) // restify <5 flushes the uncaught-exception span several seconds later
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/error`, {
                validateStatus: status => status === 599,
              })
              .catch(done)
          })
        }).timeout(15000)
      })
    })
  })
})
