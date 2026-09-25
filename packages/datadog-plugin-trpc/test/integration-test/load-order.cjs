'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const path = require('node:path')

const agent = require('../../../dd-trace/test/plugins/agent')

/** @param {'trpc-first'|'http-first'} order */
async function main (order) {
  const plugins = order === 'trpc-first'
    ? ['trpc', 'http', 'express', 'router']
    : ['http', 'express', 'router', 'trpc']
  await agent.load(plugins, plugins.map(name => name === 'router' ? { middleware: false } : {}))
  // Lint runs before versioned test packages are installed.
  const express = require(path.join(__dirname, '../../../../versions/express@5')).get()
  const trpcVersion = require(path.join(__dirname, '../../../../versions/@trpc/server@11'))
  const { initTRPC } = trpcVersion.get()
  const trpc = initTRPC.create()
  const router = trpc.router({ getValue: trpc.procedure.query(() => 7) })
  const app = express()
  app.use('/tenant/:tenantId/trpc', trpcVersion.get('@trpc/server/adapters/express').createExpressMiddleware({
    router,
    createContext: () => ({}),
  }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const traceAssertion = agent.assertSomeTraces(traces => {
      const trace = traces.find(spans => spans.some(span => span.name === 'express.request'))
      assert.ok(trace)
      const httpSpan = trace.find(span => span.name === 'express.request')
      const procedures = trace.filter(span => span.name === 'trpc.procedure')
      assert.strictEqual(procedures.length, 1)
      assert.strictEqual(procedures[0].resource, 'query getValue')
      assert.match(httpSpan.resource, /\/tenant\/:tenantId\/trpc\/getValue$/)
      assert.strictEqual(String(procedures[0].parent_id), String(httpSpan.span_id))
    })
    const response = await fetch(`http://127.0.0.1:${server.address().port}/tenant/acme/trpc/getValue`)
    assert.strictEqual(response.status, 200)
    assert.deepStrictEqual(await response.json(), { result: { data: 7 } })
    await traceAssertion
    process.stdout.write(`${order}: public response and spans passed\n`)
  } finally {
    const closed = once(server, 'close')
    server.close()
    server.closeIdleConnections?.()
    await closed
    await agent.close()
  }
}

main(process.argv[2]).catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
