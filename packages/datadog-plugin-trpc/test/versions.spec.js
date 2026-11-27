'use strict'

const assert = require('node:assert/strict')
const { AsyncResource } = require('node:async_hooks')
const { once } = require('node:events')
const { createServer } = require('node:http')

const { withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { storage } = require('../../datadog-core')

/** @param {unknown} value */
function passthroughInput (value) {
  return value
}

/** @param {import('../../dd-trace/test/plugins/agent').SerializedSpan} span */
function isExpressRequest (span) {
  return span.meta.component === 'express' && span.meta['span.kind'] === 'server'
}

/** @param {import('../../dd-trace/test/plugins/agent').SerializedSpan} span */
function isTrpcProcedure (span) {
  return span.meta.component === 'trpc' && span.meta['span.kind'] === 'internal'
}

describe('trpc server version support', () => {
  const mountResource = 'GET /tenant/:tenantId/trpc'

  withVersions('trpc', '@trpc/server', version => {
    let server
    let isV10
    let caller
    let otelSemantics
    let resolvedResource

    before(async () => {
      await agent.load(['http', 'express', 'router', 'trpc'], [{}, {}, { middleware: false }, {}])

      const createConfig = require('../../dd-trace/src/config')
      otelSemantics = createConfig().DD_TRACE_OTEL_SEMANTICS_ENABLED
      resolvedResource = otelSemantics ? mountResource : mountResource + '/getValue'
      const trpcVersion = require(`../../../versions/@trpc/server@${version}`)
      isV10 = trpcVersion.version().startsWith('10.')
      const { initTRPC } = trpcVersion.get()
      const { createExpressMiddleware } = trpcVersion.get('@trpc/server/adapters/express')
      const express = require('../../../versions/express@5').get()
      const trpc = initTRPC.create()
      const router = trpc.router({
        getValue: trpc.procedure.query(() => 7),
        echo: trpc.procedure.input(passthroughInput).query(({ input }) => input),
      })
      caller = router.createCaller(Object.freeze({}))
      const app = express()
      app.use('/tenant/:tenantId/trpc', createExpressMiddleware({ router, createContext: () => Object.freeze({}) }))
      server = app.listen(0, '127.0.0.1')
      await once(server, 'listening')
    })

    after(async () => {
      if (server) {
        const closed = once(server, 'close')
        server.close()
        await closed
      }
      await agent.close()
    })

    it('names one resolved request and parents its procedure', async () => {
      const traceAssertion = agent.assertSomeTraces(traces => {
        const trace = traces.find(spans => spans.some(isExpressRequest))
        assert.ok(trace)
        const requestSpan = trace.find(isExpressRequest)
        const procedureSpans = trace.filter(isTrpcProcedure)
        assert.strictEqual(requestSpan.name, otelSemantics ? resolvedResource : 'express.request')
        assert.strictEqual(requestSpan.resource, resolvedResource)
        assert.strictEqual(procedureSpans.length, 1)
        assert.strictEqual(procedureSpans[0].name, otelSemantics ? 'query getValue' : 'trpc.procedure')
        assert.strictEqual(procedureSpans[0].resource, 'query getValue')
        assert.strictEqual(String(procedureSpans[0].parent_id), String(requestSpan.span_id))
      })

      const response = await fetch(`http://127.0.0.1:${server.address().port}/tenant/acme/trpc/getValue`)
      assert.strictEqual(response.status, 200)
      assert.deepStrictEqual(await response.json(), { result: { data: 7 } })
      await traceAssertion
    })

    it('keeps a bounded resource and sibling procedures for a batch', async () => {
      const traceAssertion = agent.assertSomeTraces(traces => {
        const trace = traces.find(spans => spans.some(isExpressRequest))
        assert.ok(trace)
        const requestSpan = trace.find(isExpressRequest)
        const procedureSpans = trace.filter(isTrpcProcedure)
        assert.strictEqual(requestSpan.resource, mountResource)
        assert.strictEqual(procedureSpans.length, 2)
        for (const span of procedureSpans) {
          assert.strictEqual(span.resource, 'query getValue')
          assert.strictEqual(String(span.parent_id), String(requestSpan.span_id))
        }
      })

      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/tenant/acme/trpc/getValue,getValue?batch=1&input=%7B%220%22%3A0%2C%221%22%3A0%7D`
      )
      assert.strictEqual(response.status, 200)
      assert.deepStrictEqual(await response.json(), [{ result: { data: 7 } }, { result: { data: 7 } }])
      await traceAssertion
    })

    it('follows the native batch flag for falsey and nonstandard wire values', async () => {
      for (const value of [undefined, '', '0', 'false', 'NaN', '1', '2']) {
        const batch = value === '1' || (isV10 && value !== undefined && value !== '')
        const query = value === undefined ? '' : `?batch=${value}`
        const input = batch ? '&input=%7B%220%22%3A0%7D' : ''
        const expectedResource = batch ? mountResource : resolvedResource
        const traceAssertion = agent.assertSomeTraces(traces => {
          const trace = traces.find(spans => spans.some(isExpressRequest))
          assert.ok(trace)
          assert.strictEqual(trace.find(isExpressRequest).resource, expectedResource)
          assert.strictEqual(trace.filter(isTrpcProcedure).length, 1)
        })

        const response = await fetch(
          `http://127.0.0.1:${server.address().port}/tenant/acme/trpc/getValue${query}${input}`
        )
        assert.strictEqual(response.status, 200)
        const result = { result: { data: 7 } }
        assert.deepStrictEqual(await response.json(), batch ? [result] : result)
        await traceAssertion
      }
    })

    it('preserves direct caller input values and object identity', async () => {
      const absentTrace = agent.assertSomeTraces(traces => {
        assert.ok(traces.flat().some(span => span.resource === 'query echo'))
      })
      assert.strictEqual(await caller.echo(), undefined)
      await absentTrace

      for (const input of [undefined, null, 0, false, '', NaN, Object.freeze({ value: 1 })]) {
        const traceAssertion = agent.assertSomeTraces(traces => {
          const trace = traces.find(spans => spans.some(span => span.resource === 'query echo'))
          assert.ok(trace)
          assert.strictEqual(trace.filter(isTrpcProcedure).length, 1)
        })
        assert.strictEqual(await caller.echo(input), input)
        await traceAssertion
      }
    })
  })
})

describe('tRPC HTTP resource sampling', () => {
  const tenantResource = 'GET /tenant/:tenantId/trpc'
  const procedureResource = tenantResource + '/getValue'
  const mountResource = 'GET /batch/:tenantId/trpc'
  const nestedResource = 'GET /nested/:tenantId/trpc'
  const applicationRoute = '/application-route'

  withVersions('trpc', '@trpc/server', version => {
    let tracer
    let server
    let standaloneHandler
    let otelSemantics
    let isV10
    let errorCall

    function inject () {
      const carrier = {}
      tracer.trace('outbound', span => tracer.inject(span, 'http_headers', carrier))
      return carrier['x-datadog-sampling-priority']
    }

    before(async () => {
      tracer = await agent.load(['http', 'express', 'router', 'trpc', 'http2', 'find-my-way'], [
        { client: false }, { middleware: false }, { middleware: false }, {}, { client: false }, {},
      ], {
        rateLimit: -1,
        sampleRate: 0,
        samplingRules: [
          { resource: procedureResource, sampleRate: 1 },
          { resource: mountResource, sampleRate: 1 },
          { resource: nestedResource + '/inner', sampleRate: 1 },
          { resource: 'GET ' + applicationRoute, sampleRate: 1 },
          { resource: 'GET /legacy-error/:tenantId/trpc/write', sampleRate: 1 },
          { resource: 'GET /getValue', sampleRate: 1 },
          { resource: 'GET', sampleRate: 1 },
        ],
      })
      const createConfig = require('../../dd-trace/src/config')
      otelSemantics = createConfig().DD_TRACE_OTEL_SEMANTICS_ENABLED

      const trpcVersion = require(`../../../versions/@trpc/server@${version}`)
      isV10 = trpcVersion.version().startsWith('10.')
      const { initTRPC } = trpcVersion.get()
      const { createExpressMiddleware } = trpcVersion.get('@trpc/server/adapters/express')
      const { fetchRequestHandler } = trpcVersion.get('@trpc/server/adapters/fetch')
      const { createHTTPHandler } = trpcVersion.get('@trpc/server/adapters/standalone')
      const express = require('../../../versions/express@5').get()
      const trpc = initTRPC.create()
      const router = trpc.router({
        getValue: trpc.procedure.query(({ ctx }) => ctx.priority ?? (ctx.phase === 'after' ? 7 : inject())),
        inner: trpc.procedure.query(inject),
        write: trpc.procedure.mutation(inject),
      })
      standaloneHandler = createHTTPHandler({ router, createContext: () => ({}) })
      const middleware = createExpressMiddleware({
        router,
        async createContext ({ req }) {
          const phase = req.headers['x-sampling-phase']
          if (phase === 'inside-direct') {
            return { phase, priority: await router.createCaller({}).getValue() }
          }
          if (phase === 'after-direct') {
            await router.createCaller({ phase: 'after' }).getValue()
            return { phase, priority: inject() }
          }
          if (phase === 'nested-fetch') {
            const response = await fetchRequestHandler({
              endpoint: '/trpc',
              req: new Request('http://localhost/trpc/inner'),
              router,
              createContext: () => ({}),
            })
            assert.strictEqual(response.status, 200)
            const body = await response.json()
            return { phase, priority: body.result.data }
          }
          if (phase === 'manual') tracer.scope().active().setTag('resource.name', 'manual')
          if (phase === 'manual-route') tracer.scope().active().setTag('http.route', applicationRoute)
          return { phase, priority: phase === 'before' ? inject() : undefined }
        },
        responseMeta ({ ctx }) {
          return ctx?.phase === 'after' ? { headers: { 'x-priority': inject() } } : {}
        },
        onError ({ req }) {
          if (req.headers['x-sampling-phase'] === 'on-error') {
            errorCall = router.createCaller({}).write()
          }
        },
      })
      const app = express()
      app.use('/tenant/:tenantId/trpc', middleware)
      app.use('/batch/:tenantId/trpc', middleware)
      app.use('/nested/:tenantId/trpc', middleware)
      app.use('/legacy-error/:tenantId/trpc', middleware)
      app.use(middleware)
      server = app.listen(0, '127.0.0.1')
      await once(server, 'listening')
    })

    after(async () => {
      if (server) await new Promise(resolve => server.close(resolve))
      await agent.close()
    })

    /**
     * @param {'batch' | 'tenant' | 'nested' | 'legacy-error'} mount
     * @param {string} phase
     * @param {0 | 1 | 2} [batch]
     * @param {string} [procedure]
     * @param {number} [expectedStatus]
     */
    async function request (mount, phase, batch = 0, procedure = 'getValue', expectedStatus = 200) {
      let path = '/' + mount + '/acme/trpc/' + procedure
      if (batch === 1) path += '?batch=1&input=' + encodeURIComponent(JSON.stringify({ 0: 0 }))
      if (batch === 2) path += ',getValue?batch=1&input=' + encodeURIComponent(JSON.stringify({ 0: 0, 1: 0 }))
      const url = 'http://127.0.0.1:' + server.address().port + path
      const response = await fetch(url, { headers: { 'x-sampling-phase': phase } })
      assert.strictEqual(response.status, expectedStatus)
      const body = await response.json()
      if (expectedStatus !== 200) {
        return body
      }
      if (phase === 'after') return response.headers.get('x-priority')
      if (batch) assert.strictEqual(body.length, batch)
      return (batch ? body[0] : body).result.data
    }

    for (const phase of ['procedure', 'after']) {
      it('samples the HTTP resource ' + (phase === 'after' ? 'after' : 'inside') + ' the procedure', async () => {
        const resource = otelSemantics ? mountResource : procedureResource
        const [priority] = await Promise.all([
          request(otelSemantics ? 'batch' : 'tenant', phase),
          agent.assertFirstTraceSpan({ resource, metrics: { _sampling_priority_v1: 2 } }),
        ])
        assert.strictEqual(priority, '2')
      })
    }

    for (const batch of [1, 2]) {
      it('uses the bounded resource for a batch of ' + batch, async () => {
        const [priority] = await Promise.all([
          request('batch', 'procedure', batch),
          agent.assertFirstTraceSpan({ resource: mountResource, metrics: { _sampling_priority_v1: 2 } }),
        ])
        assert.strictEqual(priority, '2')
      })
    }

    it('falls back before the procedure is selected', async () => {
      const [priority] = await Promise.all([
        request('tenant', 'before'),
        agent.assertUserRejectedTrace(otelSemantics ? tenantResource : procedureResource),
      ])
      assert.strictEqual(priority, '-1')
    })

    for (const batch of [0, 1]) {
      // The mount resource is published before native dispatch in OTel semantics.
      it('preserves an existing OTel resource before native dispatch, batch size ' + batch, async function () {
        if (!otelSemantics) {
          return this.skip()
        }

        const [priority] = await Promise.all([
          request('batch', 'before', batch),
          agent.assertFirstTraceSpan({ resource: mountResource, metrics: { _sampling_priority_v1: 2 } }),
        ])
        assert.strictEqual(priority, '2')
      })
    }

    for (const phase of ['inside-direct', 'after-direct']) {
      it('falls back when propagating ' + phase.replace('-', ' a ') + ' call to the same procedure', async () => {
        const [priority] = await Promise.all([
          request('tenant', phase),
          agent.assertUserRejectedTrace(otelSemantics ? tenantResource : procedureResource),
        ])
        assert.strictEqual(priority, '-1')
      })
    }

    it('falls back for a direct call before native batch dispatch', async () => {
      const priority = otelSemantics ? '2' : '-1'
      const [propagated] = await Promise.all([
        request('batch', 'inside-direct', 2),
        otelSemantics
          ? agent.assertFirstTraceSpan({ resource: mountResource, metrics: { _sampling_priority_v1: 2 } })
          : agent.assertUserRejectedTrace(mountResource),
      ])
      assert.strictEqual(propagated, priority)
    })

    it('does not take a route from a nested Fetch adapter', async () => {
      const [priority] = await Promise.all([
        request('nested', 'nested-fetch'),
        agent.assertUserRejectedTrace(otelSemantics ? nestedResource : nestedResource + '/getValue'),
      ])
      assert.strictEqual(priority, '-1')
    })

    for (const batch of [0, 1]) {
      // v10 reports NOT_FOUND when GET targets a mutation.
      it('does not sample a direct call after a rejected v10 request, batch size ' + batch, async function () {
        if (!isV10) {
          return this.skip()
        }

        errorCall = undefined
        await request(batch ? 'batch' : 'legacy-error', 'on-error', batch, 'write', 404)
        assert.ok(errorCall)
        assert.strictEqual(await errorCall, batch && otelSemantics ? '2' : '-1')
      })
    }

    it('keeps an application resource override ahead of the matched route', async () => {
      const [priority] = await Promise.all([
        request(otelSemantics ? 'batch' : 'tenant', 'manual'),
        agent.assertUserRejectedTrace('manual'),
      ])
      assert.strictEqual(priority, '-1')
    })

    it('samples an explicit HTTP route when a mounted procedure starts', async () => {
      const [priority] = await Promise.all([
        request('nested', 'manual-route'),
        agent.assertFirstTraceSpan({ resource: 'GET ' + applicationRoute, metrics: { _sampling_priority_v1: 2 } }),
      ])
      assert.strictEqual(priority, '2')
    })

    it('samples a singleton procedure mounted at the Express root', async () => {
      const [response] = await Promise.all([
        fetch('http://127.0.0.1:' + server.address().port + '/getValue'),
        agent.assertFirstTraceSpan({
          resource: 'GET /getValue',
          meta: { 'http.route': '/getValue' },
          metrics: { _sampling_priority_v1: 2 },
        }),
      ])
      assert.strictEqual(response.status, 200)
      assert.strictEqual((await response.json()).result.data, '2')
    })

    it('preserves the method-only resource without an HTTP mount', async () => {
      const standalone = createServer(standaloneHandler).listen(0, '127.0.0.1')
      try {
        await once(standalone, 'listening')
        const url = 'http://127.0.0.1:' + standalone.address().port + '/getValue'
        const [response] = await Promise.all([
          fetch(url),
          otelSemantics
            ? agent.assertFirstTraceSpan({ resource: 'GET', metrics: { _sampling_priority_v1: 2 } })
            : agent.assertUserRejectedTrace('GET'),
        ])
        assert.strictEqual(response.status, 200)
        const body = await response.json()
        assert.strictEqual(body.result.data, otelSemantics ? '2' : '-1')
      } finally {
        await new Promise(resolve => standalone.close(resolve))
      }
    })

    // tRPC 11 introduced the standalone HTTP/2 adapter.
    it('releases a routed HTTP/2 request from procedure continuations after close', async function () {
      const rpc = require('../../../versions/@trpc/server@' + version)
      const { createHTTP2Handler } = rpc.get('@trpc/server/adapters/standalone')
      if (typeof createHTTP2Handler !== 'function') {
        return this.skip()
      }

      const { initTRPC } = rpc.get()
      const http2 = require('node:http2')
      const FindMyWay = require('../../../versions/find-my-way@9.10.2').get()
      const legacy = storage('legacy')
      const readCarrier = () => legacy.getStore()?.trpcCarrier
      let continuation
      let inheritedDispatch
      let responseClosed
      let tracing = true
      const router = FindMyWay()
      const trpc = initTRPC.create()
      const procedures = trpc.router({
        getValue: trpc.procedure.query(() => {
          const carrier = readCarrier()
          if (!tracing) {
            assert.strictEqual(carrier, undefined)
            return 7
          }
          assert.ok(carrier.req instanceof http2.Http2ServerRequest)
          assert.ok(carrier.adapterInput instanceof Request)
          assert.strictEqual(typeof carrier.inputReaders, 'function')
          continuation = AsyncResource.bind(readCarrier, 'tRPC background work')
          inheritedDispatch = AsyncResource.bind(router.lookup.bind(router), 'tRPC nested request')
          tracer.use('http2', { enabled: false })
          return 7
        }),
      })
      router.on('GET', '/trpc/:procedure', createHTTP2Handler({
        router: procedures,
        basePath: '/trpc/',
        createContext: () => ({}),
      }))
      const listener = http2.createServer((req, res) => {
        responseClosed = once(res, 'close')
        if (req.headers['x-use-inherited-scope']) inheritedDispatch(req, res)
        else router.lookup(req, res)
      }).listen(0, '127.0.0.1')

      await once(listener, 'listening')
      const client = http2.connect('http://127.0.0.1:' + listener.address().port)
      /** @param {boolean} inheritScope */
      async function dispatch (inheritScope) {
        const headers = { ':path': '/trpc/getValue' }
        if (inheritScope) headers['x-use-inherited-scope'] = '1'
        const stream = client.request(headers)
        const [responseHeaders] = await once(stream, 'response')
        stream.setEncoding('utf8')
        let body = ''
        for await (const chunk of stream) body += chunk
        assert.strictEqual(responseHeaders[':status'], 200, body)
        assert.strictEqual(JSON.parse(body).result.data, 7)
        await responseClosed
      }

      try {
        await dispatch(false)
        const { req, adapterInput, inputReaders } = continuation()
        assert.strictEqual(req, undefined)
        assert.strictEqual(adapterInput, undefined)
        assert.strictEqual(inputReaders, undefined)

        tracing = false
        await dispatch(false)
        await dispatch(true)
      } finally {
        tracer.use('http2', { enabled: true, client: false })
        client.destroy()
        await new Promise(resolve => listener.close(resolve))
      }
    })
  })
})
