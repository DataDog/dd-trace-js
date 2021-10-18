'use strict'

const axios = require('axios')
const getPort = require('get-port')
const http = require('http')
const semver = require('semver')

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

const composeP = (...fs) => x =>
  fs.reduceRight(then, x)

const cry = Function.prototype
const logger = Function.prototype

const sort = spans =>
  spans.sort((a, b) =>
    a.start.toString() >= b.start.toString() ? 1 : -1
  )

const then = (x, f) =>
  Promise.resolve(x).then(f)

describe('Plugin', () => {
  let paperplane
  let server
  let span
  let tracer

  const sandbox = sinon.createSandbox()

  before(() => {
    sandbox.spy(console, 'info')
  })

  afterEach(() => {
    sandbox.resetHistory()
  })

  after(() => {
    sandbox.restore()
  })

  describe('paperplane', () => {
    withVersions(plugin, 'paperplane', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
      })

      afterEach(() => {
        server.close()
      })

      describe('without configuration', () => {
        before(() => {
          return agent.load('paperplane')
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          paperplane = require(`../../../versions/paperplane@${version}`).get()
        })

        it('should instrument exact routes', done => {
          const { methods, mount, routes, send } = paperplane

          const app = routes({
            '/user': methods({
              GET: () => send()
            })
          })

          server = http.createServer(mount({ app, cry, logger }))

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('service', 'test')
                expect(spans[0]).to.have.property('type', 'web')
                expect(spans[0]).to.have.property('name', 'paperplane.request')
                expect(spans[0]).to.have.property('resource', 'GET /user')
                expect(spans[0].meta).to.have.property('span.kind', 'server')
                expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
                expect(spans[0].meta).to.have.property('http.method', 'GET')
                expect(spans[0].meta).to.have.property('http.status_code', '200')
              })
              .then(done)
              .catch(done)

            server.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`)
                .catch(done)
            })
          })
        })

        it('should instrument route patterns', done => {
          const { methods, mount, routes, send } = paperplane

          const app = routes({
            '/user/:id': methods({
              GET: () => send()
            })
          })

          server = http.createServer(mount({ app, cry, logger }))

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('resource', 'GET /user/:id')
              })
              .then(done)
              .catch(done)

            server.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user/1`)
                .catch(done)
            })
          })
        })

        it('should not lose the current path when changing scope', done => {
          const { methods, mount, routes, send } = paperplane

          const endpoints = routes({
            '/user/:id': methods({
              GET: () => send()
            })
          })

          const changeScope = req =>
            new Promise(resolve => {
              const childOf = tracer.scope().active()
              const child = tracer.startSpan('child', { childOf })

              tracer.scope().activate(child, () => {
                child.finish()
                resolve(req)
              })
            })

          const app = composeP(endpoints, changeScope)

          server = http.createServer(mount({ app, cry, logger }))

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('resource', 'GET /user/:id')
              })
              .then(done)
              .catch(done)

            server.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user/123`)
                .catch(done)
            })
          })
        })

        it('should not lose the current path without a scope', done => {
          const { methods, mount, routes, send } = paperplane

          const endpoints = routes({
            '/user/:id': methods({
              GET: () => send()
            })
          })

          const removeScope = req =>
            new Promise(resolve =>
              tracer.scope().activate(null, () => resolve(req))
            )

          const app = composeP(endpoints, removeScope)

          server = http.createServer(mount({ app, cry, logger }))

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('resource', 'GET /user/:id')
              })
              .then(done)
              .catch(done)

            server.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user/123`)
                .catch(done)
            })
          })
        })

        it('should not lose the current path on error', done => {
          const { methods, mount, routes } = paperplane

          const app = routes({
            '/app': methods({
              GET: () => Promise.reject(new Error())
            })
          })

          server = http.createServer(mount({ app, cry, logger }))

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('resource', 'GET /app')
              })
              .then(done)
              .catch(done)

            server.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/app`, {
                  validateStatus: status => status === 500
                })
                .catch(done)
            })
          })
        })

        it('should fallback to the the verb if a path pattern could not be found', done => {
          const { mount, send } = paperplane

          const app = () => send()

          server = http.createServer(mount({ app, cry, logger }))

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('resource', 'GET')
              })
              .then(done)
              .catch(done)

            server.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/app`)
                .catch(done)
            })
          })
        })

        it('should only include paths for routes that matched', done => {
          const { methods, mount, routes, send } = paperplane

          const ok = () => send()

          const app = routes({
            '/app/baz': ok,
            '/app/qux': ok,
            '/app/user/:id': methods({ GET: ok }),
            '/bar': ok,
            '/foo': ok
          })

          server = http.createServer(mount({ app, cry, logger }))

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('resource', 'GET /app/user/:id')
              })
              .then(done)
              .catch(done)

            server.listen(port, 'localhost', () => {
              axios.get(`http://localhost:${port}/app/user/123`)
                .catch(done)
            })
          })
        })

        it('should extract its parent span from the headers', done => {
          const { methods, mount, routes, send } = paperplane

          const app = routes({
            '/user': methods({
              GET: () => send()
            })
          })

          server = http.createServer(mount({ app, cry, logger }))

          getPort().then(port => {
            agent.use(traces => {
              const spans = sort(traces[0])

              expect(spans[0].trace_id.toString()).to.equal('1234')
              expect(spans[0].parent_id.toString()).to.equal('5678')
            })
              .then(done)
              .catch(done)

            server.listen(port, 'localhost', () => {
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
          const { methods, mount, routes } = paperplane

          const app = routes({
            '/user': methods({
              GET: () => ({ statusCode: 500 })
            })
          })

          server = http.createServer(mount({ app, cry, logger }))

          getPort().then(port => {
            agent.use(traces => {
              const spans = sort(traces[0])

              expect(spans[0]).to.have.property('error', 1)
              expect(spans[0]).to.have.property('resource', 'GET /user')
              expect(spans[0].meta).to.have.property('http.status_code', '500')

              done()
            })

            server.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`, {
                  validateStatus: status => status === 500
                })
                .catch(done)
            })
          })
        })

        it('should only handle errors for configured status codes', done => {
          const { methods, mount, routes } = paperplane

          const app = routes({
            '/user': methods({
              GET: () => ({ statusCode: 400 })
            })
          })

          server = http.createServer(mount({ app, cry, logger }))

          getPort().then(port => {
            agent.use(traces => {
              const spans = sort(traces[0])

              expect(spans[0]).to.have.property('error', 0)
              expect(spans[0]).to.have.property('resource', 'GET /user')
              expect(spans[0].meta).to.have.property('http.status_code', '400')

              done()
            })

            server.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`, {
                  validateStatus: status => status === 400
                })
                .catch(done)
            })
          })
        })

        it('should handle request errors', done => {
          const { mount } = paperplane

          const app = () => { throw new Error('boom') }

          server = http.createServer(mount({ app, cry, logger }))

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('error', 1)
                expect(spans[0].meta).to.have.property('http.status_code', '500')
              })
              .then(done)
              .catch(done)

            server.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`, {
                  validateStatus: status => status === 500
                })
                .catch(done)
            })
          })
        })

        if (semver.intersects(version, '>=2.3.1')) {
          it('should not alter the behavior of `logger`', done => {
            span = tracer.startSpan('test')

            tracer.scope().activate(span, () => {
              /* eslint-disable no-console */
              paperplane.logger({ message: ':datadoge:' })

              expect(console.info).to.have.been.called

              const record = JSON.parse(console.info.firstCall.args[0])

              expect(record).to.not.have.property('dd')
              expect(record).to.have.property('message', ':datadoge:')
              done()
              /* eslint-enable no-console */
            })
          })
        }
      })

      describe('with configuration', () => {
        before(() => {
          return agent.load('paperplane', {
            service: 'custom',
            validateStatus: code => code < 400,
            headers: ['User-Agent']
          })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          tracer._tracer._logInjection = true
          paperplane = require(`../../../versions/paperplane@${version}`).get()
        })

        it('should be configured with the correct service name', done => {
          const { methods, mount, routes, send } = paperplane

          const app = routes({
            '/user': methods({
              GET: () => send()
            })
          })

          server = http.createServer(mount({ app, cry, logger }))

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('service', 'custom')
              })
              .then(done)
              .catch(done)

            server.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`)
                .catch(done)
            })
          })
        })

        it('should be configured with the correct status code validator', done => {
          const { methods, mount, routes } = paperplane

          const app = routes({
            '/user': methods({
              GET: () => ({ statusCode: 400 })
            })
          })

          server = http.createServer(mount({ app, cry, logger }))

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('error', 1)
              })
              .then(done)
              .catch(done)

            server.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`, {
                  validateStatus: status => status === 400
                })
                .catch(done)
            })
          })
        })

        it('should include specified headers in metadata', done => {
          const { methods, mount, routes, send } = paperplane

          const app = routes({
            '/user': methods({
              GET: () => send()
            })
          })

          server = http.createServer(mount({ app, cry, logger }))

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0].meta).to.have.property('http.request.headers.user-agent', 'test')
              })
              .then(done)
              .catch(done)

            server.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`, {
                  headers: { 'User-Agent': 'test' }
                })
                .catch(done)
            })
          })
        })

        if (semver.intersects(version, '>=2.3.2')) {
          it('should add the trace ids to logs', done => {
            span = tracer.startSpan('test')

            tracer.scope().activate(span, () => {
              /* eslint-disable no-console */
              paperplane.logger({ message: ':datadoge:' })

              expect(console.info).to.have.been.called

              const record = JSON.parse(console.info.firstCall.args[0])

              expect(record).to.have.deep.property('dd', {
                trace_id: span.context().toTraceId(),
                span_id: span.context().toSpanId()
              })

              expect(record).to.have.property('message', ':datadoge:')
              done()
              /* eslint-enable no-console */
            })
          })

          it('should add the trace ids to error logs', done => {
            span = tracer.startSpan('test')

            tracer.scope().activate(span, () => {
              /* eslint-disable no-console */
              const err = new Error('Bad things happened')
              paperplane.logger(err)

              expect(console.info).to.have.been.called

              const record = JSON.parse(console.info.firstCall.args[0])

              expect(record).to.have.deep.property('dd', {
                trace_id: span.context().toTraceId(),
                span_id: span.context().toSpanId()
              })

              expect(record).to.have.property('message', 'Bad things happened')
              expect(record).to.have.property('name', 'Error')
              expect(record).to.have.property('stack')
              done()
              /* eslint-enable no-console */
            })
          })

          it('should not alter logs with no active span', () => {
            /* eslint-disable no-console */
            paperplane.logger({ message: ':datadoge:' })

            expect(console.info).to.have.been.called

            const record = JSON.parse(console.info.firstCall.args[0])

            expect(record).to.not.have.property('dd')
            expect(record).to.have.property('message', ':datadoge:')
            /* eslint-enable no-console */
          })
        }
      })
    })
  })
})
