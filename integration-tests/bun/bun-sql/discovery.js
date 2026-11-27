'use strict'

const assert = require('node:assert/strict')

const { Bun } = globalThis
const SQL = Bun.SQL
const clients = []
const queries = []
const failed = process.env.SQL_DISCOVERY_FAILURE === 'true'
const wrapFailure = process.env.SQL_DISCOVERY_FAILURE === 'wrap'

Bun.SQL = new Proxy(SQL, {
  construct (target, args) {
    const client = Reflect.construct(target, args, target)
    clients.push(client)
    const query = client`SELECT 1`
    queries.push(query)
    if (failed) {
      const adapter = Object.getOwnPropertySymbols(query).find(symbol => symbol.description === 'adapter')
      query[adapter] = undefined
      return Object.assign(() => query, { close: () => client.close() })
    }
    return client
  },
})

const wrappedSQL = Bun.SQL
const seed = new SQL('postgres://localhost/postgres')
const prototype = Object.getPrototypeOf(seed`SELECT 1`)
seed.close()
const originalThen = prototype.then
const defineProperty = Object.defineProperty
let threw = false
if (wrapFailure) {
  Object.defineProperty = (target, key, descriptor) => {
    if (!threw && target === prototype && key === 'setText') {
      threw = true
      throw new Error('Failed to install query wrapper')
    }
    return defineProperty(target, key, descriptor)
  }
}
require('dd-trace').init({ startupLogs: false })
Object.defineProperty = defineProperty

assert.equal(Bun.SQL, wrappedSQL)
assert.equal(clients.length, failed ? 1 : 3)
if (failed || wrapFailure) {
  assert.equal(prototype.then, originalThen)
  if (wrapFailure) assert.ok(threw)
} else {
  assert.notEqual(prototype.then, originalThen)
  for (const query of queries) {
    const symbol = Object.getOwnPropertySymbols(query).find(symbol => symbol.description === 'adapter')
    const adapter = query[symbol]
    if (adapter.connectionInfo.adapter !== 'sqlite') {
      assert.equal(adapter.connections.length, 0)
      assert.equal(adapter.totalQueries, 0)
      assert.equal(adapter.isConnected(), false)
    }
  }
}

Bun.SQL = SQL
// eslint-disable-next-line no-console
console.log('ok')
