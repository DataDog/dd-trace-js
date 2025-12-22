'use strict'

const assert = require('node:assert/strict')
const { AsyncLocalStorage } = require('node:async_hooks')

const axios = require('axios')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const semver = require('semver')
const sinon = require('sinon')

const { assertObjectContains } = require('../../../integration-tests/helpers')
const { NODE_MAJOR } = require('../../../version')
const { ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const plugin = require('../src')
const sort = spans => spans.sort((a, b) => a.start.toString() >= b.start.toString() ? 1 : -1)

describe('Plugin', () => {
  let tracer
  let express
  let appListener

  describe('express', () => {
    withVersions('express', 'express', version => {
    // Express.js 4.10.5 and below have a Node.js incompatibility in the `fresh` package RE res._headers missing
      if (semver.intersects(version, '<=4.10.5') && NODE_MAJOR >= 24) {
        describe.skip(
          `refusing to run tests as express@${version} is incompatible with Node.js ${NODE_MAJOR}`,
          () => {}
        )
        return
      }

      beforeEach(() => {
        tracer = require('../../dd-trace')
      })

      afterEach(() => {
        appListener && appListener.close()
        appListener = null
      })

      describe('without http', () => {
        before(() => {
          return agent.load(['express', 'router'], [{ client: false }, {}])
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          express = require(`../../../versions/express@${version}`).get()
        })

        it('should not instrument', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port
            const timer = setTimeout(done, 100)

            agent.assertSomeTraces(() => {
              clearTimeout(timer)
              done(new Error('Agent received an unexpected trace.'))
            })

            axios
              .get(`http://localhost:${port}/user`)
              .catch(done)
          })
        })

        it('should ignore middleware errors', (done) => {
          const app = express()

          app.use(() => { throw new Error('boom') })
          app.use((err, req, res, next) => {
            res.status(200).send()
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            axios
              .get(`http://localhost:${port}/user`)
              .then(() => done())
              .catch(done)
          })
        })
      })

      describe('without configuration', () => {
        before(() => {
          return agent.load(['express', 'http', 'router'], [{}, { client: false }, {}])
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          express = require(`../../../versions/express@${version}`).get()
        })

        it('should do automatic instrumentation on app routes', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assertObjectContains(spans[0], {
                  service: 'test',
                  type: 'web',
                  resource: 'GET /user',
                  meta: {
                    component: 'express',
                    'span.kind': 'server',
                    'http.url': `http://localhost:${port}/user`,
                    'http.method': 'GET',
                    'http.status_code': '200',
                    'http.route': '/user'
                  }
                })
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/user`)
              .catch(done)
          })
        })

        it('should do automatic instrumentation on routers', done => {
          const app = express()
          const router = express.Router()

          router.get('/user/:id', (req, res) => {
            res.status(200).send()
          })

          app.use('/app', router)

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assertObjectContains(spans[0], {
                  service: 'test',
                  type: 'web',
                  resource: 'GET /app/user/:id',
                  meta: {
                    component: 'express',
                    '_dd.integration': 'express',
                    'span.kind': 'server',
                    'http.url': `http://localhost:${port}/app/user/1`,
                    'http.method': 'GET',
                    'http.status_code': '200'
                  }
                })
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/app/user/1`)
              .catch(done)
          })
        })

        it('should do automatic instrumentation on routes', done => {
          const app = express()
          const router = express.Router()

          router
            .route('/user/:id')
            .all((req, res) => {
              res.status(200).send()
            })

          app.use('/app', router)

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assertObjectContains(spans[0], {
                  service: 'test',
                  type: 'web',
                  resource: 'GET /app/user/:id',
                  meta: {
                    component: 'express',
                    'span.kind': 'server',
                    'http.url': `http://localhost:${port}/app/user/1`,
                    'http.method': 'GET',
                    'http.status_code': '200'
                  }
                })
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/app/user/1`)
              .catch(done)
          })
        })

        it('should do automatic instrumentation on middleware', done => {
          const app = express()
          const router = express.Router()

          router.get('/user/:id', (req, res) => {
            res.status(200).send()
          })

          app.use(function named (req, res, next) { next() })
          app.use('/app', router)

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])
                const isExpress4 = semver.intersects(version, '<5.0.0')
                let index = 0
                const whichMiddleware = isExpress4 ? 'express' : 'router'

                const rootSpan = spans[index++]
                assertObjectContains(rootSpan, {
                  resource: 'GET /app/user/:id',
                  name: 'express.request',
                  meta: {
                    component: 'express'
                  }
                })

                if (isExpress4) {
                  assertObjectContains(spans[index], {
                    resource: 'query',
                    name: 'express.middleware',
                    meta: {
                      component: 'express'
                    }
                  })
                  assert.strictEqual(spans[index].parent_id.toString(), rootSpan.span_id.toString())
                  index++

                  assertObjectContains(spans[index], {
                    resource: 'expressInit',
                    name: 'express.middleware',
                    meta: {
                      component: 'express'
                    }
                  })
                  assert.strictEqual(spans[index].parent_id.toString(), rootSpan.span_id.toString())
                  index++
                }

                assertObjectContains(spans[index], {
                  resource: 'named',
                  name: `${whichMiddleware}.middleware`,
                  meta: {
                    component: whichMiddleware
                  }
                })
                assert.strictEqual(spans[index].parent_id.toString(), rootSpan.span_id.toString())
                index++

                assertObjectContains(spans[index], {
                  resource: 'router',
                  name: `${whichMiddleware}.middleware`,
                  meta: {
                    component: whichMiddleware
                  }
                })
                assert.strictEqual(spans[index].parent_id.toString(), rootSpan.span_id.toString())
                index++

                if (isExpress4) {
                  assert.match(spans[index].resource, /^bound\s.*$/)
                } else {
                  assert.strictEqual(spans[index].resource, 'handle')
                }
                assertObjectContains(spans[index], {
                  name: `${whichMiddleware}.middleware`,
                  meta: {
                    component: whichMiddleware
                  }
                })
                assert.strictEqual(spans[index].parent_id.toString(), spans[index - 1].span_id.toString())
                index++

                assertObjectContains(spans[index], {
                  resource: '<anonymous>',
                  name: `${whichMiddleware}.middleware`,
                  meta: {
                    component: whichMiddleware
                  }
                })
                assert.strictEqual(spans[index].parent_id.toString(), spans[index - 1].span_id.toString())

                assert.strictEqual(index, spans.length - 1)
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/app/user/1`)
              .catch(done)
          })
        })

        it('should do automatic instrumentation on middleware that break the async context', done => {
          let next

          const app = express()
          const interval = setInterval(() => {
            if (next) {
              next()
              clearInterval(interval)
            }
          })

          app.use(function breaking (req, res, _next) {
            next = _next
          })
          app.get('/user/:id', (req, res) => {
            res.status(200).send()
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                const breakingSpanIndex = semver.intersects(version, '<5.0.0') ? 3 : 1
                const whichMiddleware = semver.intersects(version, '<5.0.0')
                  ? 'express'
                  : 'router'

                assertObjectContains(spans[0], {
                  resource: 'GET /user/:id',
                  name: 'express.request',
                  meta: {
                    component: 'express'
                  }
                })
                assertObjectContains(spans[breakingSpanIndex], {
                  resource: 'breaking',
                  name: `${whichMiddleware}.middleware`,
                  meta: {
                    component: whichMiddleware
                  }
                })
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/user/1`)
              .catch(done)
          })
        })

        it('should handle errors on middleware that break the async context', done => {
          let next

          const error = new Error('boom')
          const app = express()
          const interval = setInterval(() => {
            if (next) {
              next()
              clearInterval(interval)
            }
          })

          app.use(function breaking (req, res, _next) {
            next = _next
          })
          app.use(() => { throw error })
          app.use((err, req, res, next) => next())
          app.get('/user/:id', (req, res) => {
            res.status(200).send()
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])
                const errorSpanIndex = semver.intersects(version, '<5.0.0') ? 4 : 2
                const whichMiddleware = semver.intersects(version, '<5.0.0')
                  ? 'express'
                  : 'router'

                assertObjectContains(spans[0], {
                  name: 'express.request',
                  meta: {
                    component: 'express'
                  }
                })
                assertObjectContains(spans[errorSpanIndex], {
                  name: `${whichMiddleware}.middleware`,
                  meta: {
                    [ERROR_TYPE]: error.name,
                    component: whichMiddleware
                  }
                })
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/user/1`)
              .catch(done)
          })
        })

        it('should surround matchers based on regular expressions', done => {
          const app = express()
          const router = express.Router()

          router.get(/^\/user\/(\d)$/, (req, res) => {
            res.status(200).send()
          })

          app.use('/app', router)

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assert.strictEqual(spans[0].resource, 'GET /app(/^\\/user\\/(\\d)$/)')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/app/user/1`)
              .catch(done)
          })
        })

        it('should support a nested array of paths on the router', done => {
          const app = express()
          const router = express.Router()

          router.get([['/user/:id'], '/users/:id'], (req, res, next) => {
            res.status(200).send()
          })

          app.use('/app', router)

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assert.strictEqual(spans[0].resource, 'GET /app/user/:id')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/app/user/1`)
              .catch(done)
          })
        })

        it('should only keep the last matching path of a middleware stack', done => {
          const app = express()
          const router = express.Router()

          router.use('/', (req, res, next) => next())
          router.use('/*splat', (req, res, next) => next())
          router.use('/bar', (req, res, next) => next())
          router.use('/bar', (req, res, next) => {
            res.status(200).send()
          })

          app.use('/', (req, res, next) => next())
          app.use('/*splat', (req, res, next) => next())
          app.use('/foo/bar', (req, res, next) => next())
          app.use('/foo', router)

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assert.strictEqual(spans[0].resource, 'GET /foo/bar')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/foo/bar`)
              .catch(done)
          })
        })

        it('should support asynchronous routers', done => {
          const app = express()
          const router = express.Router()

          router.get('/user/:id', (req, res) => {
            setTimeout(() => res.status(200).send())
          })

          app.use('/app', router)

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assert.strictEqual(spans[0].resource, 'GET /app/user/:id')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/app/user/1`)
              .catch(done)
          })
        })

        it('should support asynchronous middlewares', done => {
          const app = express()
          const router = express.Router()

          router.use((req, res, next) => setTimeout(() => next()))
          router.get('/user/:id', (req, res) => {
            res.status(200).send()
          })

          app.use('/app', router)

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assert.strictEqual(spans[0].resource, 'GET /app/user/:id')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/app/user/1`)
              .catch(done)
          })
        })

        it('should support nested applications', done => {
          const app = express()
          const childApp = express()

          childApp.use('/child', (req, res) => {
            res.status(200).send()
          })

          app.use('/parent', childApp)

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assert.strictEqual(spans.filter(span => span.name === 'express.request').length, 1)
                assertObjectContains(spans[0], {
                  resource: 'GET /parent/child',
                  meta: {
                    component: 'express'
                  }
                })
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/parent/child`)
              .catch(done)
          })
        })

        it('should finish middleware spans when next() is called', done => {
          const app = express()

          let span

          app.use((req, res, next) => {
            span = tracer.scope().active()

            sinon.spy(span, 'finish')

            next()
          })

          app.use((req, res, next) => {
            sinon.assert.called(span.finish)
            res.status(200).send()
            done()
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            axios
              .get(`http://localhost:${port}/app/user/1`)
              .catch(done)
          })
        })

        it('should not lose the current path when changing scope', done => {
          const app = express()
          const router = express.Router()

          router.use((req, res, next) => {
            const childOf = tracer.scope().active()
            const child = tracer.startSpan('child', { childOf })

            tracer.scope().activate(child, () => {
              child.finish()
              next()
            })
          })

          router.get('/user/:id', (req, res) => {
            res.status(200).send()
          })

          app.use('/app', router)

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assert.strictEqual(spans[0].resource, 'GET /app/user/:id')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/app/user/123`)
              .catch(done)
          })
        })

        it('should not lose the current path without a scope', done => {
          const app = express()
          const router = express.Router()

          router.use((req, res, next) => {
            tracer.scope().activate(null, () => next())
          })

          router.get('/user/:id', (req, res) => {
            res.status(200).send()
          })

          app.use('/app', router)

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assert.strictEqual(spans[0].resource, 'GET /app/user/:id')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/app/user/123`)
              .catch(done)
          })
        })

        it('should not lose the current path on app error', done => {
          const app = express()

          app.get('/app', (req, res, next) => {
            next(new Error())
          })

          app.use((error, req, res, next) => {
            res.status(200).send(error.message)
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assert.strictEqual(spans[0].resource, 'GET /app')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/app`)
              .catch(done)
          })
        })

        it('should not lose the current path on router error', done => {
          const app = express()
          const Router = express.Router

          const routerA = Router()
          const routerB = Router()

          routerA.get('/a', (req, res) => {
            throw new Error()
          })
          routerB.get('/b', (req, res) => {
            res.status(200).send()
          })

          app.use('/v1', routerA)
          app.use('/v1', routerB)

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assert.strictEqual(spans[0].resource, 'GET /v1/a')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/v1/a`)
              .catch(() => {})
          })
        })

        it('should not lose the current path when route handler is a middlware', done => {
          const app = express()

          app.get('/app', (req, res, next) => {
            res.body = 'test'
            next()
          })

          app.use((req, res) => {
            res.status(200).send(req.body)
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assert.strictEqual(spans[0].resource, 'GET /app')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/app`)
              .catch(done)
          })
        })

        it('long regex should not steal path', function (done) {
          const app = express()

          try {
            app.use(/\/foo\/(bar|baz|bez)/, (req, res, next) => {
              next()
            })
          } catch (err) {
            // eslint-disable-next-line no-console
            console.log('This version of Express (>4.0 <4.6) has broken support for regex routing. Skipping this test.')
            this.skip()
            return done()
          }

          app.get('/foo/bar', (req, res) => {
            res.status(200).send('')
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assert.strictEqual(spans[0].resource, 'GET /foo/bar')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/foo/bar`)
              .catch(done)
          })
        })

        it('should work with regex having flags', function (done) {
          const app = express()

          try {
            app.use(/\/foo\/(bar|baz|bez)/i, (req, res, next) => {
              next()
            })
          } catch (err) {
            // eslint-disable-next-line no-console
            console.log('This version of Express (>4.0 <4.6) has broken support for regex routing. Skipping this test.')
            this.skip()
            return done()
          }

          app.get('/foo/bar', (req, res) => {
            res.status(200).send('')
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assert.strictEqual(spans[0].resource, 'GET /foo/bar')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/foo/bar`)
              .catch(done)
          })
        })

        it('long regex child of string router should not steal path', function (done) {
          const app = express()
          const router = express.Router()

          try {
            router.use(/\/(bar|baz|bez)/, (req, res, next) => {
              next()
            })
            app.use('/foo', router)
          } catch (err) {
            // eslint-disable-next-line no-console
            console.log('This version of Express (>4.0 <4.6) has broken support for regex routing. Skipping this test.')
            this.skip()
            return done()
          }

          app.get('/foo/bar', (req, res) => {
            res.status(200).send('')
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assert.strictEqual(spans[0].resource, 'GET /foo/bar')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/foo/bar`)
              .catch(done)
          })
        })

        it('should not lose the current path on next', done => {
          const app = express()
          const Router = express.Router

          const router = Router()

          router.get('/a', (req, res, next) => {
            res.status(200).send()
            next()
          })

          app.use('/v1', router)

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assert.strictEqual(spans[0].resource, 'GET /v1/a')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/v1/a`)
              .catch(() => {})
          })
        })

        it('should not leak the current scope to other requests when using a task queue', done => {
          const app = express()

          let handler

          const interval = setInterval(() => {
            if (handler) {
              handler()

              clearInterval(interval)

              assert.strictEqual(tracer.scope().active(), null)

              done()
            }
          })

          app.use((req, res, next) => {
            handler = next
          })

          app.get('/app', (req, res) => {
            res.status(200).send()
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            axios
              .get(`http://localhost:${port}/app`)
              .catch(done)
          })
        })

        it('should fallback to the the verb if a path pattern could not be found', done => {
          const app = express()

          app.use((req, res, next) => res.status(200).send())

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assert.strictEqual(spans[0].resource, 'GET')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/app`)
              .catch(done)
          })
        })

        it('should activate a scope per middleware', done => {
          const app = express()

          let span

          app.use((req, res, next) => {
            span = tracer.scope().active()

            tracer.scope().activate(null, () => next())
          })

          app.get('/user', (req, res) => {
            res.status(200).send()

            try {
              const activeSpan = tracer.scope().active()
              assert.ok(activeSpan)
              assert.notStrictEqual(activeSpan, span)
              done()
            } catch (e) {
              done(e)
            }
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            axios.get(`http://localhost:${port}/user`)
              .catch(done)
          })
        })

        it('should activate a span for every middleware on a route', done => {
          const app = express()

          const span = {}

          app.get(
            '/user',
            (req, res, next) => {
              tracer.scope().activate(span, () => next())
            },
            (req, res, next) => {
              res.status(200).send()

              try {
                const activeSpan = tracer.scope().active()
                assert.ok(activeSpan)
                assert.notStrictEqual(activeSpan, span)
                done()
              } catch (e) {
                done(e)
              }
            }
          )

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            axios.get(`http://localhost:${port}/user`)
              .catch(done)
          })
        })

        it('should only include paths for routes that matched', done => {
          const app = express()
          const router = express.Router()

          router.use('/baz', (req, res, next) => next())
          router.get('/user/:id', (req, res) => {
            res.status(200).send()
          })
          router.use('/qux', (req, res, next) => next())

          app.use('/foo', (req, res, next) => next())
          app.use('/app', router)
          app.use('/bar', (req, res, next) => next())

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assert.strictEqual(spans[0].resource, 'GET /app/user/:id')
              })
              .then(done)
              .catch(done)

            axios.get(`http://localhost:${port}/app/user/123`)
              .catch(done)
          })
        })

        it('should extract its parent span from the headers', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent.assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assert.strictEqual(spans[0].trace_id.toString(), '1234')
              assert.strictEqual(spans[0].parent_id.toString(), '5678')
            })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/user`, {
                headers: {
                  'x-datadog-trace-id': '1234',
                  'x-datadog-parent-id': '5678',
                  'ot-baggage-foo': 'bar'
                }
              })
              .catch(done)
          })
        })

        it('should handle error status codes', done => {
          const app = express()

          app.use((req, res, next) => {
            next()
          })

          app.get('/user', (req, res) => {
            res.status(500).send()
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent.assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assertObjectContains(spans[0], {
                error: 1,
                resource: 'GET /user',
                meta: {
                  'http.status_code': '500',
                  component: 'express'
                }
              })

              done()
            })

            axios
              .get(`http://localhost:${port}/user`, {
                validateStatus: status => status === 500
              })
              .catch(done)
          })
        })

        it('should only handle errors for configured status codes', done => {
          const app = express()

          app.use((req, res, next) => {
            next()
          })

          app.get('/user', (req, res) => {
            res.statusCode = 400
            throw new Error('boom')
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent.assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assertObjectContains(spans[0], {
                error: 0,
                resource: 'GET /user',
                meta: {
                  'http.status_code': '400',
                  component: 'express'
                }
              })

              done()
            })

            axios
              .get(`http://localhost:${port}/user`, {
                validateStatus: status => status === 400
              })
              .catch(done)
          })
        })

        it('should handle request errors', done => {
          const app = express()
          const error = new Error('boom')

          app.use(() => { throw error })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assertObjectContains(spans[0], {
                  error: 1,
                  meta: {
                    [ERROR_TYPE]: error.name,
                    [ERROR_MESSAGE]: error.message,
                    [ERROR_STACK]: error.stack,
                    'http.status_code': '500',
                    component: 'express'
                  }
                })
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/user`, {
                validateStatus: status => status === 500
              })
              .catch(done)
          })
        })

        it('should handle middleware errors', done => {
          const app = express()
          const error = new Error('boom')

          app.use((req, res, next) => next(error))
          app.use((error, req, res, next) => res.status(500).send())

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])
                const secondErrorIndex = spans.length - 2
                const whichMiddleware = semver.intersects(version, '<5.0.0')
                  ? 'express'
                  : 'router'

                assertObjectContains(spans[0], {
                  error: 1,
                  meta: {
                    [ERROR_TYPE]: error.name,
                    [ERROR_MESSAGE]: error.message,
                    [ERROR_STACK]: error.stack,
                    component: 'express'
                  }
                })
                assertObjectContains(spans[secondErrorIndex], {
                  error: 1,
                  meta: {
                    [ERROR_TYPE]: error.name,
                    [ERROR_MESSAGE]: error.message,
                    [ERROR_STACK]: error.stack,
                    component: whichMiddleware
                  }
                })
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/user`, {
                validateStatus: status => status === 500
              })
              .catch(done)
          })
        })

        it('should handle middleware exceptions', done => {
          const app = express()
          const error = new Error('boom')

          app.use((req, res) => { throw error })
          app.use((error, req, res, next) => res.status(500).send())

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])
                const secondErrorIndex = spans.length - 2

                assertObjectContains(spans[0], {
                  error: 1,
                  meta: {
                    [ERROR_TYPE]: error.name,
                    [ERROR_MESSAGE]: error.message,
                    [ERROR_STACK]: error.stack,
                    component: 'express'
                  }
                })
                assertObjectContains(spans[secondErrorIndex], {
                  error: 1,
                  meta: {
                    [ERROR_TYPE]: error.name,
                    [ERROR_MESSAGE]: error.message,
                    [ERROR_STACK]: error.stack
                  }
                })
                assertObjectContains(spans[0].meta, {
                  component: 'express'
                })
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/user`, {
                validateStatus: status => status === 500
              })
              .catch(done)
          })
        })

        it('should support capturing groups in routes', function (done) {
          if (semver.intersects(version, '>=5.0.0')) {
            this.skip()
            return done()
          }

          const app = express()

          app.get('/:path(*)', (req, res) => {
            res.status(200).send()
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assertObjectContains(spans[0], {
                  resource: 'GET /:path(*)',
                  meta: {
                    'http.url': `http://localhost:${port}/user`
                  }
                })
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/user`)
              .catch(done)
          })
        })

        it('should support wildcard path prefix matching in routes', done => {
          const app = express()

          app.get('/*user', (req, res) => {
            res.status(200).send()
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assertObjectContains(spans[0], {
                  resource: 'GET /*user',
                  meta: {
                    'http.url': `http://localhost:${port}/user`
                  }
                })
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/user`)
              .catch(done)
          })
        })

        it('should keep the properties untouched on nested router handlers', () => {
          const router = express.Router()
          const childRouter = express.Router()

          childRouter.get('/:id', (req, res) => {
            res.status(200).send()
          })

          router.use('/users', childRouter)

          const layer = router.stack.find(layer => {
            if (semver.intersects(version, '>=5.0.0')) {
              return layer.matchers.find(matcher => matcher('/users'))
            }
            return layer.regexp.test('/users')
          })

          assert.ok(Object.hasOwn(layer.handle, 'stack'))
        })

        it('should keep user stores untouched', done => {
          const app = express()
          const storage = new AsyncLocalStorage()
          const store = {}

          app.use((req, res, next) => {
            storage.run(store, () => next())
          })

          app.get('/user', (req, res) => {
            try {
              assert.strictEqual(storage.getStore(), store)
              done()
            } catch (e) {
              done(e)
            }

            res.status(200).send()
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            axios
              .get(`http://localhost:${port}/user`)
              .catch(done)
          })
        })

        it('should handle 404 errors', done => {
          const app = express()

          app.use((req, res, next) => {
            next()
          })

          app.get('/does-exist', (req, res) => {
            res.status(200).send('hi')
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent.assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assertObjectContains(spans[0], {
                error: 0,
                resource: 'GET',
                meta: {
                  'http.status_code': '404',
                  component: 'express'
                }
              })
              assert.ok(!('http.route' in spans[0].meta))
            }).then(done).catch(done)

            axios
              .get(`http://localhost:${port}/does-not-exist`, {
                validateStatus: status => status === 404
              })
              .catch(done)
          })
        })

        withVersions(plugin, 'loopback', loopbackVersion => {
          let loopback

          beforeEach(function () {
            this.timeout(5000)

            loopback = require(`../../../versions/loopback@${loopbackVersion}`).get()
          })

          it('should handle loopback with express middleware', done => {
            const app = loopback()

            app.get('/dd', (req, res) => {
              res.status(200).send()
            })

            appListener = app.listen(0, 'localhost', () => {
              const port = appListener.address().port

              agent
                .assertSomeTraces(traces => {
                  const spans = sort(traces[0])

                  assertObjectContains(spans[0], {
                    service: 'test',
                    type: 'web',
                    resource: 'GET /dd',
                    meta: {
                      'span.kind': 'server',
                      'http.url': `http://localhost:${port}/dd`,
                      'http.method': 'GET',
                      'http.status_code': '200',
                      component: 'express'
                    }
                  })
                })
                .then(done)
                .catch(done)

              axios.get(`http://localhost:${port}/dd`)
                .catch(done)
            })
          })

          it('should handle loopback re-sorting', done => {
            const app = loopback()

            app.middleware('final', [], function throwError (req, res) {
              throw new Error('should not reach')
            })

            app.get('/dd', function handleDD (req, res) {
              res.status(200).send()
            })

            appListener = app.listen(0, 'localhost', () => {
              const port = appListener.address().port

              agent
                .assertSomeTraces(traces => {
                  const spans = sort(traces[0])

                  assert.strictEqual(spans[4].name, 'express.middleware')
                  assert.strictEqual(spans[4].service, 'test')
                  assert.strictEqual(spans[4].resource, 'handleDD')
                })
                .then(done)
                .catch(done)

              axios.get(`http://localhost:${port}/dd`)
                .catch(done)
            })
          })
        })
      })

      describe('with configuration', () => {
        before(() => {
          return agent.load(['express', 'http', 'router'], [{
            service: 'custom',
            validateStatus: code => code < 400,
            headers: ['User-Agent'],
            blocklist: ['/health']
          }, { client: false }, {}])
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          express = require(`../../../versions/express@${version}`).get()
        })

        it('should be configured with the correct service name', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assert.strictEqual(spans[0].service, 'custom')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/user`)
              .catch(done)
          })
        })

        it('should be configured with the correct status code validator', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(400).send()
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assert.strictEqual(spans[0].error, 1)
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/user`, {
                validateStatus: status => status === 400
              })
              .catch(done)
          })
        })

        it('should include specified headers in metadata', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assert.strictEqual(spans[0].meta['http.request.headers.user-agent'], 'test')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/user`, {
                headers: { 'User-Agent': 'test' }
              })
              .catch(done)
          })
        })

        it('should support URL filtering', done => {
          const app = express()

          app.get('/health', (req, res) => {
            res.status(200).send()
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port
            const spy = sinon.spy()

            agent
              .assertSomeTraces(spy)
              .catch(done)

            setTimeout(() => {
              try {
                sinon.assert.notCalled(spy)
                done()
              } catch (e) {
                done(e)
              }
            }, 100)

            axios
              .get(`http://localhost:${port}/health`)
              .catch(done)
          })
        })
      })

      describe('with configuration for middleware disabled', () => {
        before(() => {
          return agent.load(['express', 'http', 'router'], [{
            middleware: false
          }, { client: false }, { middleware: false }])
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          express = require(`../../../versions/express@${version}`).get()
        })

        it('should not activate a scope per middleware', done => {
          const app = express()

          let span

          app.use(async (req, res, next) => {
            span = await tracer.scope().active()
            next()
          })

          app.get('/user', (req, res) => {
            res.status(200).send()
            try {
              const activeSpan = tracer.scope().active()
              assert.ok(activeSpan)
              assert.strictEqual(activeSpan, span)
              done()
            } catch (e) {
              done(e)
            }
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            axios.get(`http://localhost:${port}/user`)
              .catch(done)
          })
        })

        it('should not do automatic instrumentation on middleware', done => {
          const app = express()

          app.use((req, res, next) => {
            next()
          })

          app.get('/user', (req, res, next) => {
            res.status(200).send()
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assert.strictEqual(spans[0].resource, 'GET /user')
                assert.strictEqual(traces.length, 1)
              })
              .then(done)
              .catch(done)

            axios.get(`http://localhost:${port}/user`)
              .catch(done)
          })
        })

        it('should handle error status codes', done => {
          const app = express()

          app.use((req, res, next) => {
            next()
          })

          app.get('/user', (req, res) => {
            res.status(500).send()
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent.assertSomeTraces(traces => {
              const spans = sort(traces[0])

              assertObjectContains(spans[0], {
                error: 1,
                resource: 'GET /user',
                meta: {
                  'http.status_code': '500',
                  component: 'express'
                }
              })

              done()
            })

            axios
              .get(`http://localhost:${port}/user`, {
                validateStatus: status => status === 500
              })
              .catch(done)
          })
        })

        it('should only handle errors for configured status codes', done => {
          const app = express()

          app.use((req, res, next) => {
            next()
          })

          app.get('/user', (req, res) => {
            res.statusCode = 400
            throw new Error('boom')
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assertObjectContains(spans[0], {
                  error: 0,
                  resource: 'GET /user',
                  meta: {
                    'http.status_code': '400',
                    component: 'express'
                  }
                })
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/user`, {
                validateStatus: status => status === 400
              })
              .catch(done)
          })
        })

        it('should handle middleware errors', done => {
          const app = express()
          const error = new Error('boom')

          app.use((req, res) => { throw error })
          app.use((error, req, res, next) => res.status(500).send())

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assertObjectContains(spans[0], {
                  error: 1,
                  meta: {
                    [ERROR_TYPE]: error.name,
                    [ERROR_MESSAGE]: error.message,
                    [ERROR_STACK]: error.stack,
                    component: 'express'
                  }
                })
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/user`, {
                validateStatus: status => status === 500
              })
              .catch(done)
          })
        })

        it('should handle request errors', done => {
          const app = express()
          const error = new Error('boom')

          app.use(() => { throw error })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assertObjectContains(spans[0], {
                  error: 1,
                  meta: {
                    [ERROR_TYPE]: error.name,
                    [ERROR_MESSAGE]: error.message,
                    [ERROR_STACK]: error.stack,
                    'http.status_code': '500',
                    component: 'express'
                  }
                })
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/user`, {
                validateStatus: status => status === 500
              })
              .catch(done)
          })
        })
      })
    })
  })
})
