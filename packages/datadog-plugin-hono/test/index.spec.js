'use strict'

const axios = require('axios')
const agent = require('../../dd-trace/test/plugins/agent')
const {
  ERROR_TYPE,
  ERROR_MESSAGE,
  ERROR_STACK
} = require('../../dd-trace/src/constants')

const sort = spans => spans.sort((a, b) => a.start.toString() >= b.start.toString() ? 1 : -1)

describe('Plugin', () => {
  let tracer
  let server
  let app
  let serve
  let hono

  describe('hono', () => {
    withVersions('hono', 'hono', version => {
      before(() => {
        return agent.load(['hono', 'http'], [{}, { client: false }]).then(() => {
          hono = require(`../../../versions/hono@${version}`).get()
        })
      })

      after(() => {
        return agent.close({ ritmReset: false })
      })

      beforeEach(() => {
        tracer = require('../../dd-trace')
        serve = require('../../../versions/@hono/node-server@1.13.2').get().serve

        app = new hono.Hono()

        app.use((c, next) => {
          c.set('middleware', 'test')
          return next()
        })

        app.get('/user/:id', (c) => {
          return c.json({
            id: c.req.param('id'),
            middleware: c.get('middleware')
          })
        })
      })

      afterEach(() => {
        server && server.close()
        server = null
      })

      it('should do automatic instrumentation on routes', function (done) {
        server = serve({
          fetch: app.fetch,
          port: 1
        }, (i) => {
          const port = i.port

          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('name', 'hono.request')
              expect(traces[0][0]).to.have.property('service', 'test')
              expect(traces[0][0]).to.have.property('type', 'web')
              expect(traces[0][0]).to.have.property('resource', 'GET /user/:id')
              expect(traces[0][0].meta).to.have.property('span.kind', 'server')
              expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user/123`)
              expect(traces[0][0].meta).to.have.property('http.method', 'GET')
              expect(traces[0][0].meta).to.have.property('http.status_code')
              expect(traces[0][0].meta).to.have.property('component', 'hono')
              expect(Number(traces[0][0].meta['http.status_code'])).to.be.within(200, 299)
            })
            .then(done)
            .catch(done)

          axios
            .get(`http://localhost:${port}/user/123`)
            .then(r => {
              expect(r.data).to.deep.equal({
                id: '123',
                middleware: 'test'
              })
            })
            .catch(done)
        })
      })

      it('should do automatic instrumentation on nested routes', function (done) {
        const books = new hono.Hono()

        books.get('/:id', (c) => c.json({
          id: c.req.param('id'),
          name: 'test'
        }))

        app.route('/books', books)

        server = serve({
          fetch: app.fetch,
          port: 1
        }, (i) => {
          const port = i.port

          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('name', 'hono.request')
              expect(traces[0][0]).to.have.property('service', 'test')
              expect(traces[0][0]).to.have.property('type', 'web')
              expect(traces[0][0]).to.have.property('resource', 'GET /books/:id')
              expect(traces[0][0].meta).to.have.property('span.kind', 'server')
              expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/books/123`)
              expect(traces[0][0].meta).to.have.property('http.method', 'GET')
              expect(traces[0][0].meta).to.have.property('http.status_code')
              expect(traces[0][0].meta).to.have.property('component', 'hono')
              expect(Number(traces[0][0].meta['http.status_code'])).to.be.within(200, 299)
            })
            .then(done)
            .catch(done)

          axios
            .get(`http://localhost:${port}/books/123`)
            .then(r => {
              expect(r.data).to.deep.equal({
                id: '123',
                name: 'test'
              })
            })
            .catch(done)
        })
      })

      it('should handle errors', function (done) {
        const error = new Error('message')

        app.get('/error', () => {
          throw error
        })

        server = serve({
          fetch: app.fetch,
          port: 1
        }, (i) => {
          const port = i.port

          agent
            .use(traces => {
              const spans = sort(traces[0])
              expect(spans[0]).to.have.property('error', 1)
              expect(spans[0].meta).to.have.property(ERROR_TYPE, error.name)
              expect(spans[0].meta).to.have.property(ERROR_MESSAGE, error.message)
              expect(spans[0].meta).to.have.property(ERROR_STACK, error.stack)
              expect(spans[0].meta).to.have.property('http.status_code', '500')
              expect(spans[0].meta).to.have.property('component', 'hono')
            })
            .then(done)
            .catch(done)

          axios
            .get(`http://localhost:${port}/error`)
            .catch(() => {
            })
        })
      })

      it('should have active scope within request', done => {
        app.get('/request', (c) => {
          expect(tracer.scope().active()).to.not.be.null
          return c.text('test')
        })

        server = serve({
          fetch: app.fetch,
          port: 1
        }, (i) => {
          const port = i.port

          axios
            .get(`http://localhost:${port}/request`)
            .then(r => {
              expect(r.data).to.deep.equal('test')
              done()
            })
            .catch(done)
        })
      })

      it('should extract its parent span from the headers', done => {
        server = serve({
          fetch: app.fetch,
          port: 1
        }, (i) => {
          const port = i.port

          agent
            .use(traces => {
              expect(traces[0][0].trace_id.toString()).to.equal('1234')
              expect(traces[0][0].parent_id.toString()).to.equal('5678')
            })
            .then(done)
            .catch(done)

          axios
            .get(`http://localhost:${port}/user/123`, {
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
  })
})
