'use strict'

const { AsyncLocalStorage } = require('async_hooks')
const axios = require('axios')
const semver = require('semver')
const { ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

const sort = spans => spans.sort((a, b) => a.start.toString() >= b.start.toString() ? 1 : -1)

describe('Plugin', () => {
  let tracer
  let express
  let appListener

  describe('express', () => {
    withVersions('express', 'express', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
      })

      afterEach(() => {
        appListener && appListener.close()
        appListener = null
      })

      describe('without http', () => {
        before(() => {
          return agent.load('express', { client: false })
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
          return agent.load(['express', 'http'], [{}, { client: false }])
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

                expect(spans[0]).to.have.property('service', 'test')
                expect(spans[0]).to.have.property('type', 'web')
                expect(spans[0]).to.have.property('resource', 'GET /user')
                expect(spans[0].meta).to.have.property('component', 'express')
                expect(spans[0].meta).to.have.property('span.kind', 'server')
                expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
                expect(spans[0].meta).to.have.property('http.method', 'GET')
                expect(spans[0].meta).to.have.property('http.status_code', '200')
                expect(spans[0].meta).to.have.property('http.route', '/user')
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

                expect(spans[0]).to.have.property('service', 'test')
                expect(spans[0]).to.have.property('type', 'web')
                expect(spans[0]).to.have.property('resource', 'GET /app/user/:id')
                expect(spans[0].meta).to.have.property('component', 'express')
                expect(spans[0].meta).to.have.property('_dd.integration', 'express')
                expect(spans[0].meta).to.have.property('span.kind', 'server')
                expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/app/user/1`)
                expect(spans[0].meta).to.have.property('http.method', 'GET')
                expect(spans[0].meta).to.have.property('http.status_code', '200')
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

                expect(spans[0]).to.have.property('service', 'test')
                expect(spans[0]).to.have.property('type', 'web')
                expect(spans[0]).to.have.property('resource', 'GET /app/user/:id')
                expect(spans[0].meta).to.have.property('component', 'express')
                expect(spans[0].meta).to.have.property('span.kind', 'server')
                expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/app/user/1`)
                expect(spans[0].meta).to.have.property('http.method', 'GET')
                expect(spans[0].meta).to.have.property('http.status_code', '200')
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

                const rootSpan = spans[index++]
                expect(rootSpan).to.have.property('resource', 'GET /app/user/:id')
                expect(rootSpan).to.have.property('name', 'express.request')
                expect(rootSpan.meta).to.have.property('component', 'express')

                if (isExpress4) {
                  expect(spans[index]).to.have.property('resource', 'query')
                  expect(spans[index]).to.have.property('name', 'express.middleware')
                  expect(spans[index].parent_id.toString()).to.equal(rootSpan.span_id.toString())
                  expect(spans[index].meta).to.have.property('component', 'express')
                  index++

                  expect(spans[index]).to.have.property('resource', 'expressInit')
                  expect(spans[index]).to.have.property('name', 'express.middleware')
                  expect(spans[index].parent_id.toString()).to.equal(rootSpan.span_id.toString())
                  expect(spans[index].meta).to.have.property('component', 'express')
                  index++
                }

                expect(spans[index]).to.have.property('resource', 'named')
                expect(spans[index]).to.have.property('name', 'express.middleware')
                expect(spans[index].parent_id.toString()).to.equal(rootSpan.span_id.toString())
                expect(spans[index].meta).to.have.property('component', 'express')
                index++

                expect(spans[index]).to.have.property('resource', 'router')
                expect(spans[index]).to.have.property('name', 'express.middleware')
                expect(spans[index].parent_id.toString()).to.equal(rootSpan.span_id.toString())
                expect(spans[index].meta).to.have.property('component', 'express')
                index++

                if (isExpress4) {
                  expect(spans[index].resource).to.match(/^bound\s.*$/)
                } else {
                  expect(spans[index]).to.have.property('resource', 'handle')
                }
                expect(spans[index]).to.have.property('name', 'express.middleware')
                expect(spans[index].parent_id.toString()).to.equal(spans[index - 1].span_id.toString())
                expect(spans[index].meta).to.have.property('component', 'express')
                index++

                expect(spans[index]).to.have.property('resource', '<anonymous>')
                expect(spans[index]).to.have.property('name', 'express.middleware')
                expect(spans[index].parent_id.toString()).to.equal(spans[index - 1].span_id.toString())
                expect(spans[index].meta).to.have.property('component', 'express')

                expect(index).to.equal(spans.length - 1)
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

                expect(spans[0]).to.have.property('resource', 'GET /user/:id')
                expect(spans[0]).to.have.property('name', 'express.request')
                expect(spans[0].meta).to.have.property('component', 'express')
                expect(spans[breakingSpanIndex]).to.have.property('resource', 'breaking')
                expect(spans[breakingSpanIndex]).to.have.property('name', 'express.middleware')
                expect(spans[breakingSpanIndex].meta).to.have.property('component', 'express')
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

                expect(spans[0]).to.have.property('name', 'express.request')
                expect(spans[errorSpanIndex]).to.have.property('name', 'express.middleware')
                expect(spans[errorSpanIndex].meta).to.have.property(ERROR_TYPE, error.name)
                expect(spans[0].meta).to.have.property('component', 'express')
                expect(spans[errorSpanIndex].meta).to.have.property('component', 'express')
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

                expect(spans[0]).to.have.property('resource', 'GET /app(/^\\/user\\/(\\d)$/)')
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

                expect(spans[0]).to.have.property('resource', 'GET /app/user/:id')
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

                expect(spans[0]).to.have.property('resource', 'GET /foo/bar')
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

                expect(spans[0]).to.have.property('resource', 'GET /app/user/:id')
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

                expect(spans[0]).to.have.property('resource', 'GET /app/user/:id')
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

                expect(spans.filter(span => span.name === 'express.request')).to.have.length(1)
                expect(spans[0]).to.have.property('resource', 'GET /parent/child')
                expect(spans[0].meta).to.have.property('component', 'express')
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
            expect(span.finish).to.have.been.called
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

                expect(spans[0]).to.have.property('resource', 'GET /app/user/:id')
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

                expect(spans[0]).to.have.property('resource', 'GET /app/user/:id')
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

                expect(spans[0]).to.have.property('resource', 'GET /app')
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

                expect(spans[0]).to.have.property('resource', 'GET /v1/a')
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

                expect(spans[0]).to.have.property('resource', 'GET /app')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/app`)
              .catch(done)
          })
        })

        it('long regex should not steal path', done => {
          const app = express()

          try {
            app.use(/\/foo\/(bar|baz|bez)/, (req, res, next) => {
              next()
            })
          } catch (err) {
            // eslint-disable-next-line no-console
            console.log('This version of Express (>4.0 <4.6) has broken support for regex routing. Skipping this test.')
            this.skip && this.skip() // mocha allows dynamic skipping, tap does not
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

                expect(spans[0]).to.have.property('resource', 'GET /foo/bar')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/foo/bar`)
              .catch(done)
          })
        })

        it('should work with regex having flags', done => {
          const app = express()

          try {
            app.use(/\/foo\/(bar|baz|bez)/i, (req, res, next) => {
              next()
            })
          } catch (err) {
            // eslint-disable-next-line no-console
            console.log('This version of Express (>4.0 <4.6) has broken support for regex routing. Skipping this test.')
            this.skip && this.skip() // mocha allows dynamic skipping, tap does not
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

                expect(spans[0]).to.have.property('resource', 'GET /foo/bar')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/foo/bar`)
              .catch(done)
          })
        })

        it('long regex child of string router should not steal path', done => {
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
            this.skip && this.skip() // mocha allows dynamic skipping, tap does not
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

                expect(spans[0]).to.have.property('resource', 'GET /foo/bar')
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

                expect(spans[0]).to.have.property('resource', 'GET /v1/a')
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

              expect(tracer.scope().active()).to.be.null

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

                expect(spans[0]).to.have.property('resource', 'GET')
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
              expect(tracer.scope().active()).to.not.be.null.and.not.equal(span)
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
                expect(tracer.scope().active()).to.not.be.null.and.not.equal(span)
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

                expect(spans[0]).to.have.property('resource', 'GET /app/user/:id')
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

              expect(spans[0].trace_id.toString()).to.equal('1234')
              expect(spans[0].parent_id.toString()).to.equal('5678')
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

              expect(spans[0]).to.have.property('error', 1)
              expect(spans[0]).to.have.property('resource', 'GET /user')
              expect(spans[0].meta).to.have.property('http.status_code', '500')
              expect(spans[0].meta).to.have.property('component', 'express')

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

              expect(spans[0]).to.have.property('error', 0)
              expect(spans[0]).to.have.property('resource', 'GET /user')
              expect(spans[0].meta).to.have.property('http.status_code', '400')
              expect(spans[0].meta).to.have.property('component', 'express')

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

                expect(spans[0]).to.have.property('error', 1)
                expect(spans[0].meta).to.have.property(ERROR_TYPE, error.name)
                expect(spans[0].meta).to.have.property(ERROR_MESSAGE, error.message)
                expect(spans[0].meta).to.have.property(ERROR_STACK, error.stack)
                expect(spans[0].meta).to.have.property('http.status_code', '500')
                expect(spans[0].meta).to.have.property('component', 'express')
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

                expect(spans[0]).to.have.property('error', 1)
                expect(spans[0].meta).to.have.property(ERROR_TYPE, error.name)
                expect(spans[0].meta).to.have.property(ERROR_MESSAGE, error.message)
                expect(spans[0].meta).to.have.property(ERROR_STACK, error.stack)
                expect(spans[0].meta).to.have.property('component', 'express')
                expect(spans[secondErrorIndex]).to.have.property('error', 1)
                expect(spans[secondErrorIndex].meta).to.have.property(ERROR_TYPE, error.name)
                expect(spans[secondErrorIndex].meta).to.have.property(ERROR_MESSAGE, error.message)
                expect(spans[secondErrorIndex].meta).to.have.property(ERROR_STACK, error.stack)
                expect(spans[secondErrorIndex].meta).to.have.property('component', 'express')
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

                expect(spans[0]).to.have.property('error', 1)
                expect(spans[0].meta).to.have.property(ERROR_TYPE, error.name)
                expect(spans[0].meta).to.have.property(ERROR_MESSAGE, error.message)
                expect(spans[0].meta).to.have.property(ERROR_STACK, error.stack)
                expect(spans[0].meta).to.have.property('component', 'express')
                expect(spans[secondErrorIndex]).to.have.property('error', 1)
                expect(spans[secondErrorIndex].meta).to.have.property(ERROR_TYPE, error.name)
                expect(spans[secondErrorIndex].meta).to.have.property(ERROR_MESSAGE, error.message)
                expect(spans[secondErrorIndex].meta).to.have.property(ERROR_STACK, error.stack)
                expect(spans[0].meta).to.have.property('component', 'express')
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

        it('should support capturing groups in routes', done => {
          if (semver.intersects(version, '>=5.0.0')) {
            this.skip && this.skip() // mocha allows dynamic skipping, tap does not
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

                expect(spans[0]).to.have.property('resource', 'GET /:path(*)')
                expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
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

                expect(spans[0]).to.have.property('resource', 'GET /*user')
                expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
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

          expect(layer.handle).to.have.ownProperty('stack')
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
              expect(storage.getStore()).to.equal(store)
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

              expect(spans[0]).to.have.property('error', 0)
              expect(spans[0]).to.have.property('resource', 'GET')
              expect(spans[0].meta).to.have.property('http.status_code', '404')
              expect(spans[0].meta).to.have.property('component', 'express')
              expect(spans[0].meta).to.not.have.property('http.route')
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

                  expect(spans[0]).to.have.property('service', 'test')
                  expect(spans[0]).to.have.property('type', 'web')
                  expect(spans[0]).to.have.property('resource', 'GET /dd')
                  expect(spans[0].meta).to.have.property('span.kind', 'server')
                  expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/dd`)
                  expect(spans[0].meta).to.have.property('http.method', 'GET')
                  expect(spans[0].meta).to.have.property('http.status_code', '200')
                  expect(spans[0].meta).to.have.property('component', 'express')
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

                  expect(spans[4]).to.have.property('name', 'express.middleware')
                  expect(spans[4]).to.have.property('service', 'test')
                  expect(spans[4]).to.have.property('resource', 'handleDD')
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
          return agent.load(['express', 'http'], [{
            service: 'custom',
            validateStatus: code => code < 400,
            headers: ['User-Agent'],
            blocklist: ['/health']
          }, { client: false }])
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

                expect(spans[0]).to.have.property('service', 'custom')
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

                expect(spans[0]).to.have.property('error', 1)
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

                expect(spans[0].meta).to.have.property('http.request.headers.user-agent', 'test')
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
                expect(spy).to.not.have.been.called
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
          return agent.load(['express', 'http'], [{
            middleware: false
          }, { client: false }])
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

          app.use((req, res, next) => {
            span = tracer.scope().active()
            next()
          })

          app.get('/user', (req, res) => {
            res.status(200).send()
            try {
              expect(tracer.scope().active()).to.equal(span).and.to.not.be.null
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

                expect(spans[0]).to.have.property('resource', 'GET /user')
                expect(traces.length).to.equal(1)
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

              expect(spans[0]).to.have.property('error', 1)
              expect(spans[0]).to.have.property('resource', 'GET /user')
              expect(spans[0].meta).to.have.property('http.status_code', '500')
              expect(spans[0].meta).to.have.property('component', 'express')

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

                expect(spans[0]).to.have.property('error', 0)
                expect(spans[0]).to.have.property('resource', 'GET /user')
                expect(spans[0].meta).to.have.property('http.status_code', '400')
                expect(spans[0].meta).to.have.property('component', 'express')
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

                expect(spans[0]).to.have.property('error', 1)
                expect(spans[0].meta).to.have.property(ERROR_TYPE, error.name)
                expect(spans[0].meta).to.have.property(ERROR_MESSAGE, error.message)
                expect(spans[0].meta).to.have.property(ERROR_STACK, error.stack)
                expect(spans[0].meta).to.have.property('component', 'express')
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

                expect(spans[0]).to.have.property('error', 1)
                expect(spans[0].meta).to.have.property(ERROR_TYPE, error.name)
                expect(spans[0].meta).to.have.property(ERROR_MESSAGE, error.message)
                expect(spans[0].meta).to.have.property(ERROR_STACK, error.stack)
                expect(spans[0].meta).to.have.property('http.status_code', '500')
                expect(spans[0].meta).to.have.property('component', 'express')
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
