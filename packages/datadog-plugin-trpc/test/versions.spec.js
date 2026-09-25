'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')

const { withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')

/** @param {unknown} value */
function passthroughInput (value) {
  return value
}

describe('trpc server version support', () => {
  withVersions('trpc', '@trpc/server', version => {
    let server
    let isV10
    let caller

    before(async () => {
      await agent.load(['http', 'express', 'router', 'trpc'], [{}, {}, { middleware: false }, {}])

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
        const trace = traces.find(spans => spans.some(span => span.name === 'express.request'))
        assert.ok(trace)
        const requestSpan = trace.find(span => span.name === 'express.request')
        const procedureSpans = trace.filter(span => span.name === 'trpc.procedure')
        assert.strictEqual(requestSpan.resource, 'GET /tenant/:tenantId/trpc/getValue')
        assert.strictEqual(procedureSpans.length, 1)
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
        const trace = traces.find(spans => spans.some(span => span.name === 'express.request'))
        assert.ok(trace)
        const requestSpan = trace.find(span => span.name === 'express.request')
        const procedureSpans = trace.filter(span => span.name === 'trpc.procedure')
        assert.strictEqual(requestSpan.resource, 'GET /tenant/:tenantId/trpc')
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
        const expectedResource = batch
          ? 'GET /tenant/:tenantId/trpc'
          : 'GET /tenant/:tenantId/trpc/getValue'
        const traceAssertion = agent.assertSomeTraces(traces => {
          const trace = traces.find(spans => spans.some(span => span.name === 'express.request'))
          assert.ok(trace)
          assert.strictEqual(trace.find(span => span.name === 'express.request').resource, expectedResource)
          assert.strictEqual(trace.filter(span => span.name === 'trpc.procedure').length, 1)
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
          assert.strictEqual(trace.filter(span => span.name === 'trpc.procedure').length, 1)
        })
        assert.strictEqual(await caller.echo(input), input)
        await traceAssertion
      }
    })
  })
})
