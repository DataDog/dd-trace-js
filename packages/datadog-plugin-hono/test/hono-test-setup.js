'use strict'

const axios = require('axios')
const assert = require('node:assert')

class HonoTestSetup {
    async setup (module) {
        this.hono = module
        this.serve = require('../../../../versions/@hono/node-server@1.15.0').get().serve
        this.server = null
        this.port = null
    }

    async teardown () {
        if (this.server) {
            this.server.close()
            this.server = null
            this.port = null
        }
    }

    async testRoute (tracer) {
        const app = new this.hono.Hono()

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

        const port = await this.startServerWithApp(app)

        const { data } = await axios.get(`http://localhost:${port}/user/123`)

        assert.deepStrictEqual(data, {
            id: '123',
            middleware: 'test'
        })

        return {
            port,
            expectedSpan: {
                name: 'hono.request',
                service: 'test',
                type: 'web',
                resource: 'GET /user/:id',
                meta: {
                    'span.kind': 'server',
                    'http.url': `http://localhost:${port}/user/123`,
                    'http.method': 'GET',
                    'http.status_code': '200',
                    component: 'hono'
                }
            }
        }
    }

    async testNestedRoute () {
        const app = new this.hono.Hono()
        const books = new this.hono.Hono()

        books.get('/:id', (c) => c.json({
            id: c.req.param('id'),
            name: 'test'
        }))

        app.route('/books', books)

        const port = await this.startServerWithApp(app)

        const { data } = await axios.get(`http://localhost:${port}/books/12345`)

        assert.deepStrictEqual(data, {
            id: '12345',
            name: 'test'
        })

        return {
            port,
            expectedSpan: {
                name: 'hono.request',
                service: 'test',
                type: 'web',
                resource: 'GET /books/:id',
                meta: {
                    'span.kind': 'server',
                    'http.url': `http://localhost:${port}/books/12345`,
                    'http.method': 'GET',
                    'http.status_code': '200',
                    component: 'hono'
                }
            }
        }
    }

    async testError () {
        const app = new this.hono.Hono()
        const error = new Error('message')

        app.get('/error', () => {
            throw error
        })

        const port = await this.startServerWithApp(app)

        await assert.rejects(
            axios.get(`http://localhost:${port}/error`),
            {
                message: 'Request failed with status code 500',
                name: 'AxiosError'
            }
        )

        return {
            error,
            expectedSpan: {
                error: 1,
                resource: 'GET /error',
                meta: {
                    'http.status_code': '500',
                    component: 'hono'
                }
            }
        }
    }

    async testActiveScope (tracer) {
        const app = new this.hono.Hono()

        app.get('/request', (c) => {
            assert(tracer.scope().active())
            return c.text('test')
        })

        const port = await this.startServerWithApp(app)

        const { data } = await axios.get(`http://localhost:${port}/request`)

        assert.deepStrictEqual(data, 'test')

        return { port }
    }

    async testParentSpanExtraction (tracer) {
        const app = new this.hono.Hono()

        app.get('/user/:id', (c) => {
            assert(tracer.scope().active())
            return c.text('test')
        })

        const port = await this.startServerWithApp(app)

        await axios.get(`http://localhost:${port}/user/123`, {
            headers: {
                'x-datadog-trace-id': '1234',
                'x-datadog-parent-id': '5678',
                'ot-baggage-foo': 'bar'
            }
        })

        return {
            expectedSpan: {
                trace_id: 1234n,
                parent_id: 5678n
            }
        }
    }

    async startServerWithApp (app) {
        if (this.server) {
            this.server.close()
        }

        return new Promise((resolve) => {
            this.server = this.serve({
                fetch: app.fetch,
                port: 0
            }, ({ port }) => {
                this.port = port
                resolve(port)
            })
        })
    }
}

module.exports = HonoTestSetup

