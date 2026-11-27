'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { promisify } = require('node:util')

const { after, before, describe, it } = require('mocha')
const semver = require('semver')

const createConfig = require('../../dd-trace/src/config')
const { usesOtlpTraceExporter } = require('../../dd-trace/src/exporter')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const agent = require('../../dd-trace/test/plugins/agent')
const httpRequest = require('../../dd-trace/test/setup/helpers/http-client')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

const route = '/products/:id'
const resource = 'POST ' + route

describe('Koa remote resource sampling', () => {
  let tracer

  before(async () => {
    tracer = await agent.load(['koa', 'http'], [{ middleware: false }, { client: false }], {
      rateLimit: -1,
      sampleRate: 0,
    })
  })

  after(() => agent.close())

  it('uses the fallback when a trace has no HTTP request', () => {
    const config = createConfig({ sampleRate: 0, rateLimit: -1 })
    config.setRemoteConfig({
      DD_TRACE_SAMPLING_RULES: JSON.stringify([{ resource, sample_rate: 1, provenance: 'customer' }]),
    })
    tracer._tracer.configure(config)

    tracer.trace('background.worker', span => {
      const headers = {}
      tracer.inject(span, 'http_headers', headers)
      assert.strictEqual(headers['x-datadog-sampling-priority'], '-1')
    })
  })

  withVersions('koa', 'koa', '>=3', version => {
    it('uses the fallback before any middleware runs in a custom compose', async () => {
      tracer._tracer.configure(createConfig({
        sampleRate: 0,
        rateLimit: -1,
        samplingRules: [{ resource, sampleRate: 1 }],
      }))

      const Koa = require('../../../versions/koa@' + version).get()
      const app = new Koa({
        compose: () => async ctx => tracer.trace('outbound', span => {
          const headers = {}
          tracer.inject(span, 'http_headers', headers)
          ctx.body = { priority: headers['x-datadog-sampling-priority'] }
        }),
      })
      const server = app.listen(0, '127.0.0.1')
      try {
        await once(server, 'listening')
        const [{ data }] = await Promise.all([
          httpRequest.post('http://127.0.0.1:' + server.address().port + '/products/42'),
          agent.assertUserRejectedTrace('POST'),
        ])
        assert.deepStrictEqual(data, { priority: '-1' })
      } finally {
        const closeServer = promisify(server.close.bind(server))
        const close = closeServer()
        server.closeIdleConnections?.()
        await close
      }
    })
  })

  withVersions('koa', 'koa', koaVersion => {
    withVersions('koa', ['koa-router', '@koa/router'], (routerVersion, moduleName, resolvedVersion) => {
      const stages = [
        'HTTP propagation',
        'full DBM',
        'a middleware prefix',
        'an overlapping route',
        'a completed overlapping route',
        'a method options accessor',
        'a method error factory added after registration',
        'a method error factory on a custom prototype',
        'disabled method errors',
        'method options without a prototype',
      ]
      for (const stage of stages) {
        it('applies the remote resource rule at ' + stage, async function () {
          if (moduleName === '@koa/router' && semver.gte(resolvedVersion, '15.0.0') &&
              Array.prototype.toReversed === undefined) {
            this.skip()
          }

          const config = createConfig({ sampleRate: 0, rateLimit: -1 })
          tracer._tracer.configure(config)

          const Koa = require('../../../versions/koa@' + koaVersion).get()
          const Router = require('../../../versions/' + moduleName + '@' + routerVersion).get()
          const app = new Koa()
          const router = new Router()
          const db = new DatabasePlugin(tracer, {})
          db.configure({ enabled: true, dbmPropagationMode: 'full' })

          const inject = () => tracer.trace('outbound', span => {
            const headers = {}
            tracer.inject(span, 'http_headers', headers)
            return headers['x-datadog-sampling-priority']
          })

          router.use('/products', (ctx, next) => {
            // Install the rule after request entry to exercise a live Remote Config update.
            config.setRemoteConfig({
              DD_TRACE_SAMPLING_RULES: JSON.stringify([
                { name: 'koa.request', resource, sample_rate: 1, provenance: 'customer' },
                { name: 'koa.request', resource: 'POST /products/:otherId', sample_rate: 1, provenance: 'customer' },
              ]),
            })
            tracer._tracer.configure(config)
            if (stage === 'a middleware prefix') ctx.state.priority = inject()
            return next()
          })
          router.post(route, ctx => {
            if (stage === 'a completed overlapping route') {
              ctx.body = 'ok'
            } else if (stage === 'full DBM') {
              ctx.body = tracer.trace('pg.query', span => db.createDbmComment(span, 'postgres'))
            } else {
              ctx.body = { priority: ctx.state.priority ?? inject() }
            }
          })
          if (stage === 'an overlapping route' || stage === 'a completed overlapping route') {
            router.post('/products/:otherId', () => assert.fail('the later matching handler must not run'))
          }
          app.use(router.routes())
          const options = { throw: true }
          if (stage === 'HTTP propagation' || stage.startsWith('a method ')) {
            app.use(router.allowedMethods(options))
          }
          if (stage === 'a method options accessor') {
            Object.defineProperty(options, 'throw', { get: () => assert.fail('reading the method options early') })
          }
          if (stage === 'a method error factory added after registration') {
            options.methodNotAllowed = () => assert.fail('running the method error factory early')
          }
          if (stage === 'a method error factory on a custom prototype') {
            Object.setPrototypeOf(options, { notImplemented: () => assert.fail('running an inherited factory early') })
          }
          if (stage === 'disabled method errors') app.use(router.allowedMethods({ throw: false }))
          if (stage === 'method options without a prototype') {
            app.use(router.allowedMethods({ __proto__: null, throw: true }))
          }

          const server = app.listen(0, '127.0.0.1')
          try {
            await once(server, 'listening')
            const pendingRoute = stage === 'a middleware prefix' || stage === 'an overlapping route' ||
              stage.startsWith('a method ')
            let root
            const [{ data }] = await Promise.all([
              httpRequest.post('http://127.0.0.1:' + server.address().port + '/products/42'),
              pendingRoute && usesOtlpTraceExporter(config)
                ? agent.assertUserRejectedTrace(resource)
                : agent.assertFirstTraceSpan(span => { root = span }),
            ])
            if (pendingRoute) {
              assert.strictEqual(data.priority, '-1')
              if (root) assert.strictEqual(root.metrics['_dd.rule_psr'], 0)
            } else {
              if (stage === 'full DBM') assert.match(data, /traceparent='00-[a-f0-9]{32}-[a-f0-9]{16}-01'/)
              else if (stage === 'a completed overlapping route') assert.strictEqual(data, 'ok')
              else assert.strictEqual(data.priority, '2')
              assert.strictEqual(root.metrics['_dd.rule_psr'], 1)
              assert.strictEqual(root.meta['_dd.p.dm'], '-11')
            }
            if (root) assert.strictEqual(root.resource, resource)
          } finally {
            const closeServer = promisify(server.close.bind(server))
            const closed = closeServer()
            server.closeIdleConnections?.()
            await closed
          }
        })
      }
    })
  })
})
