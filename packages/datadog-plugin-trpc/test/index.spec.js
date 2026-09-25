'use strict'

const assert = require('node:assert/strict')
const { AsyncResource } = require('node:async_hooks')
const { once } = require('node:events')
const http = require('node:http')

const dc = require('dc-polyfill')

const agent = require('../../dd-trace/test/plugins/agent')

/** @param {unknown} value */
function passthroughInput (value) {
  return value
}

describe('trpc server tracing', () => {
  let app
  let router
  let server
  let releaseConcurrent
  let concurrentStarted
  let concurrentCount = 0
  let bothConcurrentStarted
  let abortStarted
  let abortStartedPromise
  let releaseAbort
  let lazyLoads = 0

  before(async () => {
    await agent.load(['http', 'express', 'router', 'trpc'], [{}, {
      hooks: {
        /**
         * @param {import('../../dd-trace/src/opentracing/span')} span
         * @param {import('node:http').IncomingMessage} req
         */
        request (span, req) {
          if (req.headers['x-manual-resource']) span.setTag('resource.name', 'GET manual-resource')
        },
      },
    }, { middleware: false }, {}])
    const express = require('express')
    const trpcVersion = require('../../../versions/@trpc/server@11')
    const { initTRPC, lazy } = trpcVersion.get()
    const trpc = initTRPC.create()
    const concurrentGate = new Promise(resolve => { releaseConcurrent = resolve })
    bothConcurrentStarted = new Promise(resolve => { concurrentStarted = resolve })
    const abortGate = new Promise(resolve => { releaseAbort = resolve })
    abortStartedPromise = new Promise(resolve => { abortStarted = resolve })
    router = trpc.router({
      getValue: trpc.procedure.input(passthroughInput).query(() => 7),
      setValue: trpc.procedure.mutation(() => 9),
      nested: trpc.procedure.query(({ ctx }) => router.createCaller(ctx).getValue()),
      mutateInput: trpc.procedure.input(passthroughInput).use(({ input, next }) => {
        input.value = 2
        return next()
      }).query(({ input }) => input),
      numbers: trpc.procedure.subscription(() => (async function * numbers () {
        yield 1
        yield 2
      })()),
      lazyPart: lazy(async () => {
        lazyLoads++
        return trpc.router({ getLazy: trpc.procedure.query(() => 10) })
      }),
      badInput: trpc.procedure.input({ parse: () => { throw new Error('input boundary') } }).query(() => 11),
      badOutput: trpc.procedure.output({ parse: () => { throw new Error('output boundary') } }).query(() => 33),
      badResolver: trpc.procedure.query(() => { throw new Error('resolver boundary') }),
      concurrent: trpc.procedure.query(async () => {
        if (++concurrentCount === 2) concurrentStarted()
        await concurrentGate
        return 8
      }),
      abort: trpc.procedure.query(async () => {
        abortStarted()
        await abortGate
        return 9
      }),
    })
    app = express()
    const trpcMiddleware = trpcVersion.get('@trpc/server/adapters/express').createExpressMiddleware({
      router,
      createContext: () => Object.freeze({}),
    })
    app.use('/tenant/:tenantId/trpc', trpcMiddleware)
    app.use('/reject/:tenantId/trpc', trpcVersion.get('@trpc/server/adapters/express').createExpressMiddleware({
      router,
      createContext: () => { throw new Error('context boundary') },
    }))
    const outside = new AsyncResource('trpc-external-middleware')
    app.use('/late/:tenantId/trpc', (req, res, next) => {
      setImmediate(() => outside.runInAsyncScope(next))
    }, trpcMiddleware)
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

  it('creates a procedure span and names a single Express request by its resolved procedure', async () => {
    const traceAssertion = agent.assertSomeTraces(traces => {
      const trace = traces.find(spans => spans.some(span => span.name === 'express.request'))
      assert.ok(trace)
      const procedureSpans = trace.filter(span => span.name === 'trpc.procedure')
      assert.strictEqual(procedureSpans.length, 1)
      assert.strictEqual(procedureSpans[0].resource, 'query getValue')
      const httpSpans = trace.filter(span => span.name === 'express.request')
      assert.strictEqual(httpSpans.length, 1)
      assert.match(httpSpans[0].resource, /\/tenant\/:tenantId\/trpc\/getValue$/)
      assert.strictEqual(String(procedureSpans[0].parent_id), String(httpSpans[0].span_id))
    })

    const response = await fetch(`http://127.0.0.1:${server.address().port}/tenant/acme/trpc/getValue`)
    assert.strictEqual(response.status, 200)
    assert.deepStrictEqual(await response.json(), { result: { data: 7 } })
    await traceAssertion
  })

  it('keeps a bounded HTTP resource and separate procedure spans for a mixed batch', async () => {
    const traceAssertion = agent.assertSomeTraces(traces => {
      const trace = traces.find(spans => spans.some(span => span.name === 'express.request'))
      assert.ok(trace)
      const httpSpans = trace.filter(span => span.name === 'express.request')
      assert.strictEqual(httpSpans.length, 1)
      assert.match(httpSpans[0].resource, /\/tenant\/:tenantId\/trpc/)
      assert.doesNotMatch(httpSpans[0].resource, /getValue|badOutput/)
      const procedureSpans = trace.filter(span => span.name === 'trpc.procedure')
      assert.deepStrictEqual(procedureSpans.map(span => span.resource), [
        'query getValue', 'query badOutput', 'query getValue',
      ])
      for (const span of procedureSpans) {
        assert.strictEqual(String(span.parent_id), String(httpSpans[0].span_id))
      }
      assert.strictEqual(procedureSpans[1].error, 1)
      assert.strictEqual(procedureSpans[0].error, 0)
      assert.strictEqual(procedureSpans[2].error, 0)
    })

    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/tenant/acme/trpc/getValue,badOutput,getValue?batch=1`
    )
    assert.strictEqual(response.status, 207)
    const body = await response.json()
    assert.strictEqual(body.length, 3)
    assert.deepStrictEqual(body[0], { result: { data: 7 } })
    assert.strictEqual(body[1].error.data.code, 'INTERNAL_SERVER_ERROR')
    assert.deepStrictEqual(body[2], { result: { data: 7 } })
    await traceAssertion
  })

  it('keeps the HTTP resource bounded for a one-call batch', async () => {
    const traceAssertion = agent.assertSomeTraces(traces => {
      const trace = traces.find(spans => spans.some(span => span.name === 'express.request'))
      assert.ok(trace)
      const httpSpan = trace.find(span => span.name === 'express.request')
      assert.doesNotMatch(httpSpan.resource, /getValue/)
      assert.strictEqual(trace.filter(span => span.name === 'trpc.procedure').length, 1)
    })

    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/tenant/acme/trpc/getValue?batch=1&input=%7B%220%22%3A0%7D`
    )
    assert.strictEqual(response.status, 200)
    assert.deepStrictEqual(await response.json(), [{ result: { data: 7 } }])
    await traceAssertion
  })

  it('does not name a missing procedure on the HTTP resource', async () => {
    const traceAssertion = agent.assertSomeTraces(traces => {
      const trace = traces.find(spans => spans.some(span => span.name === 'express.request'))
      assert.ok(trace)
      assert.strictEqual(trace.filter(span => span.name === 'trpc.procedure').length, 0)
      const httpSpan = trace.find(span => span.name === 'express.request')
      assert.doesNotMatch(httpSpan.resource, /missing/)
    })

    const response = await fetch(`http://127.0.0.1:${server.address().port}/tenant/acme/trpc/missing`)
    assert.strictEqual(response.status, 404)
    await response.text()
    await traceAssertion
  })

  it('does not name a procedure rejected by the HTTP method', async () => {
    const traceAssertion = agent.assertSomeTraces(traces => {
      const trace = traces.find(spans => spans.some(span => span.name === 'express.request'))
      assert.ok(trace)
      assert.strictEqual(trace.filter(span => span.name === 'trpc.procedure').length, 0)
      const httpSpan = trace.find(span => span.name === 'express.request')
      assert.doesNotMatch(httpSpan.resource, /setValue/)
    })

    const response = await fetch(`http://127.0.0.1:${server.address().port}/tenant/acme/trpc/setValue`)
    assert.strictEqual(response.status, 405)
    await response.text()
    await traceAssertion
  })

  it('names a resolved procedure with malformed input', async () => {
    const traceAssertion = agent.assertSomeTraces(traces => {
      const trace = traces.find(spans => spans.some(span => span.name === 'express.request'))
      assert.ok(trace)
      const httpSpan = trace.find(span => span.name === 'express.request')
      assert.strictEqual(httpSpan.resource, 'GET /tenant/:tenantId/trpc/getValue')
      const procedureSpans = trace.filter(span => span.name === 'trpc.procedure')
      assert.strictEqual(procedureSpans.length, 1)
      assert.strictEqual(procedureSpans[0].resource, 'query getValue')
      assert.strictEqual(procedureSpans[0].error, 1)
    })

    const response = await fetch(`http://127.0.0.1:${server.address().port}/tenant/acme/trpc/getValue?input=bad`)
    assert.strictEqual(response.status, 400)
    await response.text()
    await traceAssertion
  })

  it('keeps a rejected context on the bounded HTTP resource without a procedure span', async () => {
    const traceAssertion = agent.assertSomeTraces(traces => {
      const trace = traces.find(spans => spans.some(span => span.name === 'express.request'))
      assert.ok(trace)
      assert.strictEqual(trace.filter(span => span.name === 'trpc.procedure').length, 0)
      assert.strictEqual(trace.find(span => span.name === 'express.request').resource,
        'GET /reject/:tenantId/trpc')
    })

    const response = await fetch(`http://127.0.0.1:${server.address().port}/reject/acme/trpc/getValue`)
    assert.strictEqual(response.status, 500)
    const body = await response.json()
    assert.strictEqual(body.error.data.code, 'INTERNAL_SERVER_ERROR')
    await traceAssertion
  })

  it('marks input validation errors on the procedure span', async () => {
    const traceAssertion = agent.assertSomeTraces(traces => {
      const trace = traces.find(spans => spans.some(span => span.name === 'express.request'))
      assert.ok(trace)
      assert.strictEqual(trace.find(span => span.name === 'express.request').resource,
        'GET /tenant/:tenantId/trpc/badInput')
      const procedureSpans = trace.filter(span => span.name === 'trpc.procedure')
      assert.strictEqual(procedureSpans.length, 1)
      assert.strictEqual(procedureSpans[0].resource, 'query badInput')
      assert.strictEqual(procedureSpans[0].error, 1)
    })

    const response = await fetch(`http://127.0.0.1:${server.address().port}/tenant/acme/trpc/badInput`)
    assert.strictEqual(response.status, 400)
    const body = await response.json()
    assert.strictEqual(body.error.data.code, 'BAD_REQUEST')
    await traceAssertion
  })

  it('names resolved procedures when the resolver throws', async () => {
    const traceAssertion = agent.assertSomeTraces(traces => {
      const trace = traces.find(spans => spans.some(span => span.name === 'express.request'))
      assert.ok(trace)
      assert.strictEqual(trace.find(span => span.name === 'express.request').resource,
        'GET /tenant/:tenantId/trpc/badResolver')
      const procedureSpans = trace.filter(span => span.name === 'trpc.procedure')
      assert.strictEqual(procedureSpans.length, 1)
      assert.strictEqual(procedureSpans[0].resource, 'query badResolver')
      assert.strictEqual(procedureSpans[0].error, 1)
    })

    const response = await fetch(`http://127.0.0.1:${server.address().port}/tenant/acme/trpc/badResolver`)
    assert.strictEqual(response.status, 500)
    const body = await response.json()
    assert.strictEqual(body.error.data.code, 'INTERNAL_SERVER_ERROR')
    await traceAssertion
  })

  it('names lazy router procedures after native resolution', async () => {
    for (let call = 0; call < 2; call++) {
      const traceAssertion = agent.assertSomeTraces(traces => {
        const trace = traces.find(spans => spans.some(span => span.name === 'express.request'))
        assert.ok(trace)
        const requestSpan = trace.find(span => span.name === 'express.request')
        const procedureSpan = trace.find(span => span.name === 'trpc.procedure')
        assert.strictEqual(requestSpan.resource, 'GET /tenant/:tenantId/trpc/lazyPart.getLazy')
        assert.strictEqual(procedureSpan.resource, 'query lazyPart.getLazy')
      })

      const response = await fetch(`http://127.0.0.1:${server.address().port}/tenant/acme/trpc/lazyPart.getLazy`)
      assert.strictEqual(response.status, 200)
      assert.deepStrictEqual(await response.json(), { result: { data: 10 } })
      await traceAssertion
    }
    assert.strictEqual(lazyLoads, 1)
  })

  it('preserves the route template after asynchronous middleware', async () => {
    const traceAssertion = agent.assertSomeTraces(traces => {
      const trace = traces.find(spans => spans.some(span => span.name === 'express.request'))
      assert.ok(trace)
      const httpSpan = trace.find(span => span.name === 'express.request')
      assert.match(httpSpan.resource, /\/late\/:tenantId\/trpc\/getValue$/)
      const procedureSpan = trace.find(span => span.name === 'trpc.procedure')
      assert.ok(procedureSpan)
      assert.strictEqual(String(procedureSpan.parent_id), String(httpSpan.span_id))
    })

    const response = await fetch(`http://127.0.0.1:${server.address().port}/late/acme/trpc/getValue`)
    assert.strictEqual(response.status, 200)
    assert.deepStrictEqual(await response.json(), { result: { data: 7 } })
    await traceAssertion
  })

  it('preserves a user resource override while recording the resolved route', async () => {
    const traceAssertion = agent.assertSomeTraces(traces => {
      const trace = traces.find(spans => spans.some(span => span.name === 'express.request'))
      assert.ok(trace)
      const httpSpan = trace.find(span => span.name === 'express.request')
      assert.strictEqual(httpSpan.resource, 'GET manual-resource')
      assert.strictEqual(httpSpan.meta['http.route'], '/tenant/:tenantId/trpc/getValue')
      assert.strictEqual(trace.filter(span => span.name === 'trpc.procedure').length, 1)
    })

    const response = await fetch(`http://127.0.0.1:${server.address().port}/tenant/acme/trpc/getValue`, {
      headers: { 'x-manual-resource': '1' },
    })
    assert.strictEqual(response.status, 200)
    assert.deepStrictEqual(await response.json(), { result: { data: 7 } })
    await traceAssertion
  })

  it('traces a direct mutation without an HTTP request', async () => {
    const traceAssertion = agent.assertSomeTraces(traces => {
      const trace = traces.find(spans => spans.some(span => span.resource === 'mutation setValue'))
      assert.ok(trace)
      assert.strictEqual(trace.filter(span => span.name === 'trpc.procedure').length, 1)
      assert.strictEqual(trace.filter(span => span.name === 'express.request').length, 0)
    })

    assert.strictEqual(await router.createCaller(Object.freeze({})).setValue(), 9)
    await traceAssertion
  })

  it('parents a nested direct caller under the outer procedure', async () => {
    const traceAssertion = agent.assertSomeTraces(traces => {
      const trace = traces.find(spans => spans.some(span => span.resource === 'query nested'))
      assert.ok(trace)
      const outer = trace.find(span => span.resource === 'query nested')
      const inner = trace.find(span => span.resource === 'query getValue')
      assert.ok(outer)
      assert.ok(inner)
      assert.strictEqual(String(inner.parent_id), String(outer.span_id))
    })

    assert.strictEqual(await router.createCaller(Object.freeze({})).nested(), 7)
    await traceAssertion
  })

  it('preserves middleware input mutation through the resolver', async () => {
    const traceAssertion = agent.assertSomeTraces(traces => {
      const trace = traces.find(spans => spans.some(span => span.resource === 'query mutateInput'))
      assert.ok(trace)
      assert.strictEqual(trace.filter(span => span.name === 'trpc.procedure').length, 1)
    })

    const input = { value: 1 }
    assert.deepStrictEqual(await router.createCaller(Object.freeze({})).mutateInput(input), { value: 2 })
    assert.strictEqual(input.value, 2)
    await traceAssertion
  })

  it('preserves returned subscription iteration', async () => {
    const values = []
    const iterator = await router.createCaller(Object.freeze({})).numbers()
    for await (const value of iterator) values.push(value)
    assert.deepStrictEqual(values, [1, 2])
  })

  it('keeps simultaneous requests under their own HTTP roots', async () => {
    const requestTraces = []
    const traceAssertion = agent.assertSomeTraces(traces => {
      requestTraces.push(...traces.filter(spans => spans.some(span => span.name === 'express.request')))
      assert.strictEqual(requestTraces.length, 2)
      const rootIds = new Set()
      for (const trace of requestTraces) {
        const requestSpan = trace.find(span => span.name === 'express.request')
        const procedureSpan = trace.find(span => span.name === 'trpc.procedure')
        assert.strictEqual(requestSpan.resource, 'GET /tenant/:tenantId/trpc/concurrent')
        assert.strictEqual(procedureSpan.resource, 'query concurrent')
        assert.strictEqual(String(procedureSpan.parent_id), String(requestSpan.span_id))
        rootIds.add(String(requestSpan.span_id))
      }
      assert.strictEqual(rootIds.size, 2)
    })

    const base = `http://127.0.0.1:${server.address().port}/tenant/acme/trpc/concurrent`
    const responses = Promise.all([fetch(`${base}?input=1`), fetch(`${base}?input=2`)])
    try {
      await bothConcurrentStarted
    } finally {
      releaseConcurrent()
    }
    const [first, second] = await responses
    assert.deepStrictEqual(await Promise.all([first.json(), second.json()]), [
      { result: { data: 8 } }, { result: { data: 8 } },
    ])
    await traceAssertion
  })

  it('keeps the next request independent after a client abort', async () => {
    const finishChannel = dc.channel('apm:http:server:request:finish')
    let onFinish
    const abortedFinish = new Promise(resolve => {
      onFinish = ({ req }) => {
        if (req.url.endsWith('/abort')) resolve()
      }
      finishChannel.subscribe(onFinish)
    })
    const base = `http://127.0.0.1:${server.address().port}/tenant/acme/trpc`
    const request = http.get(`${base}/abort`)
    const abortedError = once(request, 'error')
    try {
      await abortStartedPromise
      request.destroy()
      await Promise.all([abortedError, abortedFinish])

      const traceAssertion = agent.assertSomeTraces(traces => {
        const trace = traces.find(spans => spans.some(span => span.resource === 'query getValue'))
        assert.ok(trace)
        const requestSpan = trace.find(span => span.name === 'express.request')
        const procedureSpan = trace.find(span => span.resource === 'query getValue')
        assert.strictEqual(requestSpan.resource, 'GET /tenant/:tenantId/trpc/getValue')
        assert.strictEqual(String(procedureSpan.parent_id), String(requestSpan.span_id))
      })
      const response = await fetch(`${base}/getValue`)
      assert.strictEqual(response.status, 200)
      assert.deepStrictEqual(await response.json(), { result: { data: 7 } })
      await traceAssertion
    } finally {
      finishChannel.unsubscribe(onFinish)
      releaseAbort()
    }
  })

  it('removes and restores procedure tracing and route naming when reconfigured', async () => {
    agent.reload('trpc', false)
    try {
      const disabledTrace = agent.assertSomeTraces(traces => {
        const trace = traces.find(spans => spans.some(span => span.name === 'express.request'))
        assert.ok(trace)
        assert.strictEqual(trace.filter(span => span.name === 'trpc.procedure').length, 0)
        assert.doesNotMatch(trace.find(span => span.name === 'express.request').resource, /getValue/)
      })
      const disabledResponse = await fetch(`http://127.0.0.1:${server.address().port}/tenant/acme/trpc/getValue`)
      assert.strictEqual(disabledResponse.status, 200)
      assert.deepStrictEqual(await disabledResponse.json(), { result: { data: 7 } })
      await disabledTrace
    } finally {
      agent.reload('trpc', {})
    }

    const enabledTrace = agent.assertSomeTraces(traces => {
      const trace = traces.find(spans => spans.some(span => span.name === 'express.request'))
      assert.ok(trace)
      assert.strictEqual(trace.filter(span => span.name === 'trpc.procedure').length, 1)
      assert.match(trace.find(span => span.name === 'express.request').resource,
        /\/tenant\/:tenantId\/trpc\/getValue$/)
    })
    const enabledResponse = await fetch(`http://127.0.0.1:${server.address().port}/tenant/acme/trpc/getValue`)
    assert.strictEqual(enabledResponse.status, 200)
    assert.deepStrictEqual(await enabledResponse.json(), { result: { data: 7 } })
    await enabledTrace
  })
})
