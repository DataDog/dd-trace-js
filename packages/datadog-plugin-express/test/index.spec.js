'use strict'

const axios = require('axios')
const getPort = require('get-port')
const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

wrapIt()

const sort = spans => spans.sort((a, b) => a.start.toString() >= b.start.toString() ? 1 : -1)

describe('Plugin', () => {
  let tracer
  let express
  let appListener

  describe('express', () => {
    withVersions(plugin, 'express', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
      })

      afterEach(() => {
        appListener.close()
      })

      describe('without configuration', () => {
        before(() => {
          return agent.load(plugin, 'express')
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          express = require(`../../../versions/express@${version}`).get()
        })

        it('should do automatic instrumentation on app routes', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('service', 'test')
                expect(spans[0]).to.have.property('type', 'web')
                expect(spans[0]).to.have.property('resource', 'GET /user')
                expect(spans[0].meta).to.have.property('span.kind', 'server')
                expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
                expect(spans[0].meta).to.have.property('http.method', 'GET')
                expect(spans[0].meta).to.have.property('http.status_code', '200')
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`)
                .catch(done)
            })
          })
        })

        it('should do automatic instrumentation on routers', done => {
          const app = express()
          const router = express.Router()

          router.get('/user/:id', (req, res) => {
            res.status(200).send()
          })

          app.use('/app', router)

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('service', 'test')
                expect(spans[0]).to.have.property('type', 'web')
                expect(spans[0]).to.have.property('resource', 'GET /app/user/:id')
                expect(spans[0].meta).to.have.property('span.kind', 'server')
                expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/app/user/1`)
                expect(spans[0].meta).to.have.property('http.method', 'GET')
                expect(spans[0].meta).to.have.property('http.status_code', '200')
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/app/user/1`)
                .catch(done)
            })
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

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('service', 'test')
                expect(spans[0]).to.have.property('type', 'web')
                expect(spans[0]).to.have.property('resource', 'GET /app/user/:id')
                expect(spans[0].meta).to.have.property('span.kind', 'server')
                expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/app/user/1`)
                expect(spans[0].meta).to.have.property('http.method', 'GET')
                expect(spans[0].meta).to.have.property('http.status_code', '200')
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/app/user/1`)
                .catch(done)
            })
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

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans).to.have.length(7)

                expect(spans[0]).to.have.property('resource', 'GET /app/user/:id')
                expect(spans[0]).to.have.property('name', 'express.request')
                expect(spans[1]).to.have.property('resource', 'query')
                expect(spans[1]).to.have.property('name', 'express.middleware')
                expect(spans[1].parent_id.toString()).to.equal(spans[0].trace_id.toString())
                expect(spans[2]).to.have.property('resource', 'expressInit')
                expect(spans[2]).to.have.property('name', 'express.middleware')
                expect(spans[3]).to.have.property('resource', 'named')
                expect(spans[3]).to.have.property('name', 'express.middleware')
                expect(spans[4]).to.have.property('resource', 'router')
                expect(spans[4]).to.have.property('name', 'express.middleware')
                expect(spans[5].resource).to.match(/^bound\s.*$/)
                expect(spans[5]).to.have.property('name', 'express.middleware')
                expect(spans[6]).to.have.property('resource', '<anonymous>')
                expect(spans[6]).to.have.property('name', 'express.middleware')
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/app/user/1`)
                .catch(done)
            })
          })
        })

        it('should surround matchers based on regular expressions', done => {
          const app = express()
          const router = express.Router()

          router.get(/^\/user\/(\d)$/, (req, res) => {
            res.status(200).send()
          })

          app.use('/app', router)

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('resource', 'GET /app(/^\\/user\\/(\\d)$/)')
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/app/user/1`)
                .catch(done)
            })
          })
        })

        it('should support a nested array of paths on the router', done => {
          const app = express()
          const router = express.Router()

          router.get([['/user/:id'], '/users/:id'], (req, res, next) => {
            res.status(200).send()
          })

          app.use('/app', router)

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('resource', 'GET /app/user/:id')
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/app/user/1`)
                .catch(done)
            })
          })
        })

        it('should only keep the last matching path of a middleware stack', done => {
          const app = express()
          const router = express.Router()

          router.use('/', (req, res, next) => next())
          router.use('*', (req, res, next) => next())
          router.use('/bar', (req, res, next) => next())
          router.use('/bar', (req, res, next) => {
            res.status(200).send()
          })

          app.use('/', (req, res, next) => next())
          app.use('*', (req, res, next) => next())
          app.use('/foo/bar', (req, res, next) => next())
          app.use('/foo', router)

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('resource', 'GET /foo/bar')
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/foo/bar`)
                .catch(done)
            })
          })
        })

        it('should support asynchronous routers', done => {
          const app = express()
          const router = express.Router()

          router.get('/user/:id', (req, res) => {
            setTimeout(() => res.status(200).send())
          })

          app.use('/app', router)

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('resource', 'GET /app/user/:id')
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/app/user/1`)
                .catch(done)
            })
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

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('resource', 'GET /app/user/:id')
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/app/user/1`)
                .catch(done)
            })
          })
        })

        it('should support nested applications', done => {
          const app = express()
          const childApp = express()

          childApp.use('/child', (req, res) => {
            res.status(200).send()
          })

          app.use('/parent', childApp)

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans.filter(span => span.name === 'express.request')).to.have.length(1)
                expect(spans[0]).to.have.property('resource', 'GET /parent/child')
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/parent/child`)
                .catch(done)
            })
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

          getPort().then(port => {
            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/app/user/1`)
                .catch(done)
            })
          })
        })

        it('should not lose the current path when changing scope', done => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

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

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('resource', 'GET /app/user/:id')
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/app/user/123`)
                .catch(done)
            })
          })
        })

        it('should not lose the current path without a scope', done => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

          const app = express()
          const router = express.Router()

          router.use((req, res, next) => {
            tracer.scope().activate(null, () => next())
          })

          router.get('/user/:id', (req, res) => {
            res.status(200).send()
          })

          app.use('/app', router)

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('resource', 'GET /app/user/:id')
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/app/user/123`)
                .catch(done)
            })
          })
        })

        it('should not lose the current path on error', done => {
          const app = express()

          app.get('/app', (req, res, next) => {
            next(new Error())
          })

          app.use((error, req, res, next) => {
            res.status(200).send(error.message)
          })

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('resource', 'GET /app')
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/app`)
                .catch(done)
            })
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

          getPort().then(port => {
            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/app`)
                .catch(done)
            })
          })
        })

        it('should fallback to the the verb if a path pattern could not be found', done => {
          const app = express()

          app.use((req, res, next) => res.status(200).send())

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('resource', 'GET')
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/app`)
                .catch(done)
            })
          })
        })

        it('should activate a scope per middleware', done => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

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

          getPort().then(port => {
            appListener = app.listen(port, 'localhost', () => {
              axios.get(`http://localhost:${port}/user`)
                .catch(done)
            })
          })
        })

        it('should activate a span for every middleware on a route', done => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

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

          getPort().then(port => {
            appListener = app.listen(port, 'localhost', () => {
              axios.get(`http://localhost:${port}/user`)
                .catch(done)
            })
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

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('resource', 'GET /app/user/:id')
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios.get(`http://localhost:${port}/app/user/123`)
                .catch(done)
            })
          })
        })

        it('should extract its parent span from the headers', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          getPort().then(port => {
            agent.use(traces => {
              const spans = sort(traces[0])

              expect(spans[0].trace_id.toString()).to.equal('1234')
              expect(spans[0].parent_id.toString()).to.equal('5678')
            })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
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
        })

        it('should handle error status codes', done => {
          const app = express()

          app.use((req, res, next) => {
            next()
          })

          app.get('/user', (req, res) => {
            res.status(500).send()
          })

          getPort().then(port => {
            agent.use(traces => {
              const spans = sort(traces[0])

              expect(spans[0]).to.have.property('error', 1)
              expect(spans[0]).to.have.property('resource', 'GET /user')
              expect(spans[0].meta).to.have.property('http.status_code', '500')

              done()
            })

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`, {
                  validateStatus: status => status === 500
                })
                .catch(done)
            })
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

          getPort().then(port => {
            agent.use(traces => {
              const spans = sort(traces[0])

              expect(spans[0]).to.have.property('error', 0)
              expect(spans[0]).to.have.property('resource', 'GET /user')
              expect(spans[0].meta).to.have.property('http.status_code', '400')

              done()
            })

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`, {
                  validateStatus: status => status === 400
                })
                .catch(done)
            })
          })
        })

        it('should handle request errors', done => {
          const app = express()
          const error = new Error('boom')

          app.use(() => { throw error })

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('error', 1)
                expect(spans[0].meta).to.have.property('http.status_code', '500')
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`, {
                  validateStatus: status => status === 500
                })
                .catch(done)
            })
          })
        })

        it('should handle middleware errors', done => {
          const app = express()
          const error = new Error('boom')

          app.use((req, res) => { throw error })
          app.use((error, req, res, next) => res.status(500).send())

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[3]).to.have.property('error', 1)
                expect(spans[3].meta).to.have.property('error.type', error.name)
                expect(spans[3].meta).to.have.property('error.msg', error.message)
                expect(spans[3].meta).to.have.property('error.stack', error.stack)
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`, {
                  validateStatus: status => status === 500
                })
                .catch(done)
            })
          })
        })

        it('should support capturing groups in routes', done => {
          const app = express()

          app.get('/:path(*)', (req, res) => {
            res.status(200).send()
          })

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('resource', 'GET /:path(*)')
                expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`)
                .catch(done)
            })
          })
        })

        withVersions(plugin, 'loopback', loopbackVersion => {
          let loopback

          beforeEach(() => {
            loopback = require(`../../../versions/loopback@${loopbackVersion}`).get()
          })

          it('should handle loopback with express middleware', done => {
            const app = loopback()

            app.get('/dd', (req, res) => {
              res.status(200).send()
            })

            getPort().then(port => {
              agent
                .use(traces => {
                  const spans = sort(traces[0])

                  expect(spans[0]).to.have.property('service', 'test')
                  expect(spans[0]).to.have.property('type', 'web')
                  expect(spans[0]).to.have.property('resource', 'GET /dd')
                  expect(spans[0].meta).to.have.property('span.kind', 'server')
                  expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/dd`)
                  expect(spans[0].meta).to.have.property('http.method', 'GET')
                  expect(spans[0].meta).to.have.property('http.status_code', '200')
                })
                .then(done)
                .catch(done)

              appListener = app.listen(port, 'localhost', () => {
                axios.get(`http://localhost:${port}/dd`)
                  .catch(done)
              })
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

            getPort().then(port => {
              agent
                .use(traces => {
                  const spans = sort(traces[0])

                  expect(spans[4]).to.have.property('name', 'express.middleware')
                  expect(spans[4]).to.have.property('service', 'test')
                  expect(spans[4]).to.have.property('resource', 'handleDD')
                })
                .then(done)
                .catch(done)

              appListener = app.listen(port, 'localhost', () => {
                axios.get(`http://localhost:${port}/dd`)
                  .catch(done)
              })
            })
          })
        })
      })

      describe('with configuration', () => {
        before(() => {
          return agent.load(plugin, 'express', {
            service: 'custom',
            validateStatus: code => code < 400,
            headers: ['User-Agent']
          })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          express = require(`../../../versions/express@${version}`).get()
        })

        it('should be configured with the correct service name', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('service', 'custom')
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`)
                .catch(done)
            })
          })
        })

        it('should be configured with the correct status code validator', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(400).send()
          })

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('error', 1)
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`, {
                  validateStatus: status => status === 400
                })
                .catch(done)
            })
          })
        })

        it('should include specified headers in metadata', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0].meta).to.have.property('http.request.headers.user-agent', 'test')
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`, {
                  headers: { 'User-Agent': 'test' }
                })
                .catch(done)
            })
          })
        })
      })

      describe('with configuration for middleware disabled', () => {
        before(() => {
          return agent.load(plugin, 'express', {
            middleware: false
          })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          express = require(`../../../versions/express@${version}`).get()
        })

        it('should not activate a scope per middleware', done => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

          const app = express()

          let span

          app.use((req, res, next) => {
            span = tracer.scope().active()

            next()
          })

          app.get('/user', (req, res) => {
            res.status(200).send()
            try {
              expect(tracer.scope().active()).to.equal(span)
              done()
            } catch (e) {
              done(e)
            }
          })

          getPort().then(port => {
            appListener = app.listen(port, 'localhost', () => {
              axios.get(`http://localhost:${port}/user`)
                .catch(done)
            })
          })
        })

        it('should not activate a span for every middleware on a route with middleware disabled ', done => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

          const app = express()

          app.use((req, res, next) => {
            next()
          })

          app.get('/user', (req, res, next) => {
            res.status(200).send()
          })

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('resource', 'GET /user')
                expect(traces.length).to.equal(1)
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios.get(`http://localhost:${port}/user`)
                .catch(done)
            })
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

          getPort().then(port => {
            agent.use(traces => {
              const spans = sort(traces[0])

              expect(spans[0]).to.have.property('error', 1)
              expect(spans[0]).to.have.property('resource', 'GET /user')
              expect(spans[0].meta).to.have.property('http.status_code', '500')

              done()
            })

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`, {
                  validateStatus: status => status === 500
                })
                .catch(done)
            })
          })
        })

        it('should only handle errors for configured status codes', done => {
          const app = express()

          app.use((req, res, next) => {
            next()
          })

          app.get('/user', (req, res) => {
            res.statusCode = 400
            res.status(400).send()
          })

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('error', 0)
                expect(spans[0]).to.have.property('resource', 'GET /user')
                expect(spans[0].meta).to.have.property('http.status_code', '400')
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`, {
                  validateStatus: status => status === 400
                })
                .catch(done)
            })
          })
        })

        it('should handle middleware errors', done => {
          const app = express()
          const error = new Error('boom')

          app.use((req, res) => { throw error })
          app.use((error, req, res, next) => res.status(500).send())

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('error', 1)
                expect(spans[0].meta).to.have.property('error.type', error.name)
                expect(spans[0].meta).to.have.property('error.msg', error.message)
                expect(spans[0].meta).to.have.property('error.stack', error.stack)
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`, {
                  validateStatus: status => status === 500
                })
                .catch(done)
            })
          })
        })

        it('should handle request errors', done => {
          const app = express()
          const error = new Error('boom')

          app.use(() => { throw error })

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('error', 1)
                expect(spans[0].meta).to.have.property('http.status_code', '500')
              })
              .then(done)
              .catch(done)

            appListener = app.listen(port, 'localhost', () => {
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
})
