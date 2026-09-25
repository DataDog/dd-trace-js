import assert from 'node:assert/strict'
import { once } from 'node:events'

if (process.env.TRPC_TRACE_MODE === 'traced') {
  await import('dd-trace/init.js')
}

const [{ initTRPC }, { createExpressMiddleware }, { default: express }] = await Promise.all([
  import('@trpc/server'),
  import('@trpc/server/adapters/express'),
  import('express'),
])

const trpc = initTRPC.create()
const router = trpc.router({
  getValue: trpc.procedure.query(() => 7),
  setValue: trpc.procedure.mutation(() => 9),
})

const caller = router.createCaller(Object.freeze({}))
const directQuery = await caller.getValue()
const directMutation = await caller.setValue()

const app = express()
app.use('/trpc', createExpressMiddleware({ router, createContext: () => Object.freeze({}) }))
const server = app.listen(0, '127.0.0.1')
await once(server, 'listening')

try {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/trpc/getValue`)
  const body = await response.json()
  assert.strictEqual(response.status, 200)
  assert.deepStrictEqual(body, { result: { data: 7 } })
  process.stdout.write(`${JSON.stringify({ directQuery, directMutation, status: response.status, body })}\n`)
} finally {
  const closed = once(server, 'close')
  server.close()
  await closed
}
