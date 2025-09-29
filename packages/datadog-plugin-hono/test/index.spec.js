'use strict'

const assert = require('node:assert')
const axios = require('axios')
const agent = require('../../dd-trace/test/plugins/agent')
const {
  ERROR_TYPE,
  ERROR_MESSAGE,
  ERROR_STACK
} = require('../../dd-trace/src/constants')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

describe('Plugin', () => {
  let tracer
  let server
  let app
  let serve
  let hono

  describe('hono', () => {
    withVersions('hono', 'hono', version => {
      before(async () => {
        await agent.load(['hono', 'http'], [{}, { client: false }])
        hono = require(`../../../versions/hono@${version}`).get()
      })

      after(() => {
        return agent.close({ ritmReset: false })
      })

      beforeEach(() => {
        tracer = require('../../dd-trace')
        serve = require('../../../versions/@hono/node-server@1.15.0').get().serve

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
        server?.close()
        server = null
      })

      it('should do automatic instrumentation on routes', async function () {
        let resolver
        const promise = new Promise((resolve) => {
          resolver = resolve
        })

        server = serve({
          fetch: app.fetch,
          port: 0
        }, ({ port }) => resolver(port))

        const port = await promise

        const { data } = await axios.get(`http://localhost:${port}/user/123`)

        assert.deepStrictEqual(data, {
          id: '123',
          middleware: 'test'
        })

        await agent.assertFirstTraceSpan({
          name: 'hono.request',
          service: 'test',
          type: 'web',
          resource: 'GET /user/:id',
          meta: {
            'span.kind': 'server',
            'http.url': `http://localhost:${port}/user/123`,
            'http.method': 'GET',
            'http.status_code': '200',
            component: 'hono',
          }
        })
      })

      it('should do automatic instrumentation on nested routes', async function () {
        let resolver
        const promise = new Promise((resolve) => {
          resolver = resolve
        })

        const books = new hono.Hono()

        books.get('/:id', (c) => c.json({
          id: c.req.param('id'),
          name: 'test'
        }))

        app.route('/books', books)

        server = serve({
          fetch: app.fetch,
          port: 0
        }, ({ port }) => resolver(port))

        const port = await promise

        const { data } = await axios.get(`http://localhost:${port}/books/12345`)

        assert.deepStrictEqual(data, {
          id: '12345',
          name: 'test'
        })

        await agent.assertFirstTraceSpan({
          name: 'hono.request',
          service: 'test',
          type: 'web',
          resource: 'GET /books/:id',
          meta: {
            'span.kind': 'server',
            'http.url': `http://localhost:${port}/books/12345`,
            'http.method': 'GET',
            'http.status_code': '200',
            component: 'hono',
          }
        })
      })

      it('should handle errors', async function () {
        let resolver
        const promise = new Promise((resolve) => {
          resolver = resolve
        })

        const error = new Error('message')

        app.get('/error', () => {
          throw error
        })

        server = serve({
          fetch: app.fetch,
          port: 0
        }, ({ port }) => resolver(port))

        const port = await promise

        await assert.rejects(
          axios.get(`http://localhost:${port}/error`),
          {
            message: 'Request failed with status code 500',
            name: 'AxiosError'
          }
        )

        await agent.assertFirstTraceSpan({
          error: 1,
          resource: 'GET /error',
          meta: {
            [ERROR_TYPE]: error.name,
            [ERROR_MESSAGE]: error.message,
            [ERROR_STACK]: error.stack,
            'http.status_code': '500',
            component: 'hono',
          }
        })
      })

      it('should have active scope within request', async () => {
        let resolver
        const promise = new Promise((resolve) => {
          resolver = resolve
        })

        app.get('/request', (c) => {
          assert(tracer.scope().active())
          return c.text('test')
        })

        server = serve({
          fetch: app.fetch,
          port: 0
        }, ({ port }) => resolver(port))

        const port = await promise

        const { data } = await axios.get(`http://localhost:${port}/request`)

        assert.deepStrictEqual(data, 'test')
      })

      it('should extract its parent span from the headers', async () => {
        let resolver
        const promise = new Promise((resolve) => {
          resolver = resolve
        })

        app.get('/request', (c) => {
          assert(tracer.scope().active())
          return c.text('test')
        })

        server = serve({
          fetch: app.fetch,
          port: 0
        }, ({ port }) => resolver(port))

        const port = await promise

        await axios.get(`http://localhost:${port}/user/123`, {
          headers: {
            'x-datadog-trace-id': '1234',
            'x-datadog-parent-id': '5678',
            'ot-baggage-foo': 'bar'
          }
        })

        await agent.assertFirstTraceSpan({
          trace_id: 1234n,
          parent_id: 5678n,
        })
      })
    })
  })
})
