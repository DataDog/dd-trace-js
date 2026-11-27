import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createRequire } from 'node:module'

import tracer from 'dd-trace/init.js'

const require = createRequire(import.meta.url)
const { version } = require('@trpc/server/package.json')
const isV10 = version.startsWith('10.')
const nestedFetchBatch = process.env.TRPC_TEST_NESTED_FETCH_BATCH === 'true'
const [{ initTRPC }, { createExpressMiddleware }, { fetchRequestHandler }, { default: express }] = await Promise.all([
  import('@trpc/server'),
  import('@trpc/server/adapters/express'),
  import('@trpc/server/adapters/fetch'),
  import('express'),
])

function inject () {
  const carrier = {}
  tracer.trace('outbound', span => tracer.inject(span, 'http_headers', carrier))
  return carrier['x-datadog-sampling-priority']
}

const trpc = initTRPC.create()
const router = trpc.router({
  getValue: trpc.procedure.query(inject),
  setValue: trpc.procedure.mutation(inject),
  quiet: trpc.procedure.query(() => 9),
  fetchBatch: trpc.procedure.query(async () => {
    const response = await fetchRequestHandler({
      endpoint: '/nested',
      req: new Request('http://localhost/nested/quiet?batch=1&input=' + encodeURIComponent('{"0":0}')),
      router,
      createContext: () => ({}),
    })
    assert.strictEqual(response.status, 200)
    const body = await response.json()
    assert.strictEqual(body.length, 1)
    return body[0].result.data
  }),
})

let rejectedCall
let nestedPriority
const app = express()
app.use('/tenant/:tenantId/trpc', createExpressMiddleware({
  router,
  async createContext ({ req }) {
    if (isV10 || req.headers['x-sampling-case'] === 'native') return {}

    const response = await fetchRequestHandler({
      endpoint: '/nested',
      req: new Request('http://localhost/nested/getValue'),
      router,
      createContext: () => ({}),
    })
    assert.strictEqual(response.status, 200)
    const body = await response.json()
    nestedPriority = body.result.data
    return {}
  },
  onError () {
    if (isV10) rejectedCall = router.createCaller({}).setValue()
  },
}))

const server = app.listen(0, '127.0.0.1')
try {
  await once(server, 'listening')
  const nativeProcedure = isV10 ? 'setValue' : 'getValue'
  const procedure = nestedFetchBatch ? 'fetchBatch' : nativeProcedure
  const url = `http://127.0.0.1:${server.address().port}/tenant/acme/trpc/${procedure}`
  const nativeResponse = await fetch(url, {
    method: isV10 && !nestedFetchBatch ? 'POST' : 'GET',
    headers: { 'x-sampling-case': 'native' },
  })
  assert.strictEqual(nativeResponse.status, 200)
  const nativeBody = await nativeResponse.json()
  assert.strictEqual(nativeBody.result.data, nestedFetchBatch ? 9 : '2')

  if (!nestedFetchBatch) {
    const response = await fetch(url)
    const body = await response.json()
    if (isV10) {
      assert.strictEqual(response.status, 404)
      assert.strictEqual(body.error.data.code, 'NOT_FOUND')
      assert.strictEqual(await rejectedCall, '-1')
    } else {
      assert.strictEqual(response.status, 200)
      assert.strictEqual(nestedPriority, '-1')
      assert.strictEqual(body.result.data, '-1')
    }
  }
} finally {
  const closed = once(server, 'close')
  server.close()
  await closed
}
