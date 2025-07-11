'use strict'

const axios = require('axios')
const http = require('http')
const agent = require('../../dd-trace/test/plugins/agent')
const { AsyncLocalStorage } = require('async_hooks')
const { ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE } = require('../../dd-trace/src/constants')

const sort = spans => spans.sort((a, b) => a.start.toString() >= b.start.toString() ? 1 : -1)

describe('Plugin', () => {
  let tracer
  let connect
  let appListener

  describe('connect', () => {
    withVersions('connect', 'connect', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
      })

      afterEach(() => {
        appListener.close()
      })

      describe('without configuration', () => {
        before(() => {
          return agent.load(['connect', 'http'], [{}, { client: false }])
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          connect = require(`../../../versions/connect@${version}`).get()
        })

        it('should do automatic instrumentation on app routes', done => {
          const app = connect()

          app.use('/user', (req, res) => {
            res.statusCode = 200
            res.end()
          })

          appListener = http.createServer(app).listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('service', 'test')
                expect(spans[0]).to.have.property('type', 'web')
                expect(spans[0]).to.have.property('resource', 'GET /user')
                expect(spans[0].meta).to.have.property('span.kind', 'server')
                expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
                expect(spans[0].meta).to.have.property('http.method', 'GET')
                expect(spans[0].meta).to.have.property('http.status_code', '200')
                expect(spans[0].meta).to.have.property('component', 'connect')
                expect(spans[0].meta).to.have.property('_dd.integration', 'connect')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/user`)
              .catch(done)
          })
        })

        it('should do automatic instrumentation on middleware', done => {
          const app = connect()

          app.use(function named (req, res, next) { next() })
          app.use('/app/user', (req, res) => res.end())

          appListener = http.createServer(app).listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                expect(spans).to.have.length(3)

                expect(spans[0]).to.have.property('resource', 'GET /app/user')
                expect(spans[0]).to.have.property('name', 'connect.request')
                expect(spans[1]).to.have.property('resource', 'named')
                expect(spans[1]).to.have.property('name', 'connect.middleware')
                expect(spans[1].parent_id.toString()).to.equal(spans[0].trace_id.toString())
                expect(spans[2]).to.have.property('resource', '<anonymous>')
                expect(spans[2]).to.have.property('name', 'connect.middleware')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/app/user/1`)
              .catch(done)
          })
        })

        it('should only keep the longest matching path of a middleware stack', done => {
          const app = connect()

          app.use('/', (req, res, next) => next())
          app.use('/foo/bar', (req, res, next) => next())
          app.use('/foo', (req, res) => res.end())

          appListener = http.createServer(app).listen(0, 'localhost', () => {
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

        it('should support nested applications', done => {
          const app = connect()
          const childApp = connect()

          childApp.use('/child', (req, res) => {
            res.end()
          })

          app.use('/parent', childApp)

          appListener = http.createServer(app).listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                expect(spans.filter(span => span.name === 'connect.request')).to.have.length(1)
                expect(spans[0]).to.have.property('resource', 'GET /parent/child')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/parent/child`)
              .catch(done)
          })
        })

        it('should finish middleware spans when next() is called', done => {
          const app = connect()

          let span

          app.use((req, res, next) => {
            span = tracer.scope().active()

            sinon.spy(span, 'finish')

            next()
          })

          app.use((req, res, next) => {
            expect(span.finish).to.have.been.called
            res.end()
            done()
          })

          appListener = http.createServer(app).listen(0, 'localhost', () => {
            const port = appListener.address().port

            axios
              .get(`http://localhost:${port}/app/user/1`)
              .catch(done)
          })
        })

        it('should not lose the current path on error', done => {
          const app = connect()

          app.use('/app', (req, res, next) => {
            next(new Error())
          })

          app.use((error, req, res, next) => {
            res.write(error.message)
            res.end()
          })

          appListener = http.createServer(app).listen(0, 'localhost', () => {
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

        it('should not leak the current scope to other requests when using a task queue', done => {
          const app = connect()

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

          app.use('/app', (req, res) => {
            res.end()
          })

          appListener = http.createServer(app).listen(0, 'localhost', () => {
            const port = appListener.address().port

            axios
              .get(`http://localhost:${port}/app`)
              .catch(done)
          })
        })

        it('should fallback to the the verb if a path pattern could not be found', done => {
          const app = connect()

          app.use((req, res, next) => res.end())

          appListener = http.createServer(app).listen(0, 'localhost', () => {
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
          const app = connect()

          let span

          app.use((req, res, next) => {
            span = tracer.scope().active()

            tracer.scope().activate(null, () => next())
          })

          app.use('/user', (req, res) => {
            res.end()

            try {
              expect(tracer.scope().active()).to.not.be.null.and.not.equal(span)
              done()
            } catch (e) {
              done(e)
            }
          })

          appListener = http.createServer(app).listen(0, 'localhost', () => {
            const port = appListener.address().port

            axios.get(`http://localhost:${port}/user`)
              .catch(done)
          })
        })

        it('should only include paths for routes that matched', done => {
          const app = connect()

          app.use('/foo', (req, res, next) => next())
          app.use('/app', (req, res) => res.end())
          app.use('/bar', (req, res, next) => next())

          appListener = http.createServer(app).listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('resource', 'GET /app')
              })
              .then(done)
              .catch(done)

            axios.get(`http://localhost:${port}/app/user/123`)
              .catch(done)
          })
        })

        it('should extract its parent span from the headers', done => {
          const app = connect()

          app.use('/user', (req, res) => {
            res.end()
          })

          appListener = http.createServer(app).listen(0, 'localhost', () => {
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
          const app = connect()

          app.use((req, res, next) => {
            next()
          })

          app.use('/user', (req, res) => {
            res.statusCode = 500
            res.end()
          })

          appListener = http.createServer(app).listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('error', 1)
                expect(spans[0]).to.have.property('resource', 'GET /user')
                expect(spans[0].meta).to.have.property('http.status_code', '500')
                expect(spans[0].meta).to.have.property('component', 'connect')
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

        it('should only handle errors for configured status codes', done => {
          const app = connect()

          app.use((req, res, next) => {
            next()
          })

          app.use('/user', (req, res) => {
            res.statusCode = 400
            throw new Error('boom')
          })

          appListener = http.createServer(app).listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('error', 0)
                expect(spans[0]).to.have.property('resource', 'GET /user')
                expect(spans[0].meta).to.have.property('http.status_code', '400')
                expect(spans[0].meta).to.have.property('component', 'connect')
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

        it('should handle request errors', done => {
          const app = connect()
          const error = new Error('boom')

          app.use(() => { throw error })

          appListener = http.createServer(app).listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('error', 1)
                expect(spans[0].meta).to.have.property(ERROR_TYPE, error.name)
                expect(spans[0].meta).to.have.property(ERROR_MESSAGE, error.message)
                expect(spans[0].meta).to.have.property(ERROR_STACK, error.stack)
                expect(spans[0].meta).to.have.property('http.status_code', '500')
                expect(spans[0].meta).to.have.property('component', 'connect')
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

        it('should keep user stores untouched', done => {
          const app = connect()
          const storage = new AsyncLocalStorage()
          const store = {}

          app.use((req, res, next) => {
            storage.run(store, () => next())
          })

          app.use((req, res) => {
            try {
              expect(storage.getStore()).to.equal(store)
              done()
            } catch (e) {
              done(e)
            }

            res.end()
          })

          appListener = http.createServer(app).listen(0, 'localhost', () => {
            const port = appListener.address().port

            axios
              .get(`http://localhost:${port}/user`)
              .catch(done)
          })
        })

        it('should handle middleware errors', done => {
          const app = connect()
          const error = new Error('boom')

          app.use((req, res) => { throw error })
          app.use((error, req, res, next) => {
            res.statusCode = 500
            res.end()
          })

          appListener = http.createServer(app).listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('error', 1)
                expect(spans[0].meta).to.have.property(ERROR_TYPE, error.name)
                expect(spans[0].meta).to.have.property(ERROR_MESSAGE, error.message)
                expect(spans[0].meta).to.have.property(ERROR_STACK, error.stack)
                expect(spans[0].meta).to.have.property('component', 'connect')
                expect(spans[1]).to.have.property('error', 1)
                expect(spans[1].meta).to.have.property(ERROR_TYPE, error.name)
                expect(spans[1].meta).to.have.property(ERROR_MESSAGE, error.message)
                expect(spans[1].meta).to.have.property(ERROR_STACK, error.stack)
                expect(spans[1].meta).to.have.property('component', 'connect')
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

      describe('with configuration', () => {
        before(() => {
          return agent.load(['connect', 'http'], [{
            service: 'custom',
            validateStatus: code => code < 400,
            headers: ['User-Agent']
          }, { client: false }])
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          connect = require(`../../../versions/connect@${version}`).get()
        })

        it('should be configured with the correct service name', done => {
          const app = connect()

          app.use('/user', (req, res) => {
            res.end()
          })

          appListener = http.createServer(app).listen(0, 'localhost', () => {
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
          const app = connect()

          app.use('/user', (req, res) => {
            res.statusCode = 400
            res.end()
          })

          appListener = http.createServer(app).listen(0, 'localhost', () => {
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
          const app = connect()

          app.use('/user', (req, res) => {
            res.end()
          })

          appListener = http.createServer(app).listen(0, 'localhost', () => {
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

        it('should do automatic instrumentation on app routes', done => {
          const app = connect()

          app.use('/user', (req, res) => {
            res.statusCode = 200
            res.end()
          })

          appListener = http.createServer(app).listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('service', 'custom')
                expect(spans[0]).to.have.property('type', 'web')
                expect(spans[0]).to.have.property('resource', 'GET /user')
                expect(spans[0].meta).to.have.property('span.kind', 'server')
                expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
                expect(spans[0].meta).to.have.property('http.method', 'GET')
                expect(spans[0].meta).to.have.property('http.status_code', '200')
                expect(spans[0].meta).to.have.property('component', 'connect')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/user`)
              .catch(done)
          })
        })

        it('should handle middleware errors', done => {
          const app = connect()
          const error = new Error('boom')

          app.use((req, res) => { throw error })
          app.use((error, req, res, next) => {
            res.statusCode = 500
            res.end()
          })

          appListener = http.createServer(app).listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('error', 1)
                expect(spans[0].meta).to.have.property(ERROR_TYPE, error.name)
                expect(spans[0].meta).to.have.property(ERROR_MESSAGE, error.message)
                expect(spans[0].meta).to.have.property(ERROR_STACK, error.stack)
                expect(spans[0].meta).to.have.property('component', 'connect')
                expect(spans[1]).to.have.property('error', 1)
                expect(spans[1].meta).to.have.property(ERROR_TYPE, error.name)
                expect(spans[1].meta).to.have.property(ERROR_MESSAGE, error.message)
                expect(spans[1].meta).to.have.property(ERROR_STACK, error.stack)
                expect(spans[1].meta).to.have.property('component', 'connect')
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
          const app = connect()
          const error = new Error('boom')

          app.use(() => { throw error })

          appListener = http.createServer(app).listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('error', 1)
                expect(spans[0].meta).to.have.property(ERROR_TYPE, error.name)
                expect(spans[0].meta).to.have.property(ERROR_MESSAGE, error.message)
                expect(spans[0].meta).to.have.property(ERROR_STACK, error.stack)
                expect(spans[0].meta).to.have.property('http.status_code', '500')
                expect(spans[0].meta).to.have.property('component', 'connect')
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

      describe('with middleware disabled', () => {
        before(() => {
          return agent.load(['connect', 'http'], [{
            middleware: false
          }, { client: false }])
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          connect = require(`../../../versions/connect@${version}`).get()
        })

        it('should not do automatic instrumentation on middleware', done => {
          const app = connect()

          app.use(function named (req, res, next) { next() })
          app.use('/app/user', (req, res) => res.end())

          appListener = http.createServer(app).listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                expect(spans).to.have.length(1)
                expect(spans[0]).to.have.property('resource', 'GET /app/user')
                expect(spans[0]).to.have.property('name', 'connect.request')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/app/user/1`)
              .catch(done)
          })
        })

        it('should not activate a scope per middleware', done => {
          const app = connect()

          let span

          app.use((req, res, next) => {
            span = tracer.scope().active()
            next()
          })

          app.use('/user', (req, res) => {
            res.end()

            try {
              expect(tracer.scope().active()).to.equal(span).and.to.not.be.null
              done()
            } catch (e) {
              done(e)
            }
          })

          appListener = http.createServer(app).listen(0, 'localhost', () => {
            const port = appListener.address().port

            axios.get(`http://localhost:${port}/user`)
              .catch(done)
          })
        })

        it('should handle middleware errors', done => {
          const app = connect()
          const error = new Error('boom')

          app.use((req, res) => { throw error })
          app.use((error, req, res, next) => {
            res.statusCode = 500
            res.end()
          })

          appListener = http.createServer(app).listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('error', 1)
                expect(spans[0].meta).to.have.property(ERROR_TYPE, error.name)
                expect(spans[0].meta).to.have.property(ERROR_MESSAGE, error.message)
                expect(spans[0].meta).to.have.property(ERROR_STACK, error.stack)
                expect(spans[0].meta).to.have.property('http.status_code', '500')
                expect(spans[0].meta).to.have.property('component', 'connect')
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
          const app = connect()
          const error = new Error('boom')

          app.use(() => { throw error })

          appListener = http.createServer(app).listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('error', 1)
                expect(spans[0].meta).to.have.property(ERROR_TYPE, error.name)
                expect(spans[0].meta).to.have.property(ERROR_MESSAGE, error.message)
                expect(spans[0].meta).to.have.property(ERROR_STACK, error.stack)
                expect(spans[0].meta).to.have.property('http.status_code', '500')
                expect(spans[0].meta).to.have.property('component', 'connect')
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
