'use strict'

const { channel } = require('dc-polyfill')

const shimmer = require('../../datadog-shimmer')
const log = require('../../dd-trace/src/log')

const start = channel('apm:bun-sql:query:start')
const finish = channel('apm:bun-sql:query:finish')
const error = channel('apm:bun-sql:query:error')
const contexts = new WeakMap()
let currentQuery

// Bun embeds SQL in the runtime, outside the source modules Orchestrion can rewrite.
if (process.versions.bun) {
  const wrapped = []
  try {
    const { SQL } = globalThis.Bun
    const clients = []
    const normalizers = new Set()
    let prototype
    let flagsSymbol
    try {
      for (const url of ['postgres://localhost/postgres', 'mysql://localhost/db', ':memory:']) {
        const client = new SQL(url)
        clients.push(client)
        const query = client`SELECT 1`
        prototype ??= Object.getPrototypeOf(query)
        const symbols = Object.getOwnPropertySymbols(query)
        const adapterSymbol = symbols.find(symbol => symbol.description === 'adapter')
        flagsSymbol ??= symbols.find(symbol => symbol.description === 'flags')
        if (!adapterSymbol || !flagsSymbol || Object.getPrototypeOf(query) !== prototype) {
          throw new Error('Unsupported Bun SQL query layout')
        }
        let adapter = query[adapterSymbol]
        let found = false
        while (adapter) {
          if (Object.hasOwn(adapter, 'normalizeQuery')) {
            if (typeof adapter.normalizeQuery !== 'function') throw new TypeError('Invalid Bun SQL normalizer')
            normalizers.add(adapter)
            found = true
          }
          adapter = Object.getPrototypeOf(adapter)
        }
        if (!found) throw new Error('Missing Bun SQL normalizer')
      }
      for (const method of ['then', 'execute', 'run', 'catch', 'finally', 'setText', 'resolve', 'reject']) {
        if (typeof prototype[method] !== 'function') throw new TypeError('Missing Bun SQL query method')
      }
    } finally {
      for (const client of clients) {
        client.close().catch(err => log.debug('Closing Bun SQL discovery client failed: %s', err))
      }
    }

    for (const method of ['then', 'execute', 'run', 'catch', 'finally', 'setText']) {
      wrapped.push([prototype, method, Object.getOwnPropertyDescriptor(prototype, method)])
      shimmer.wrap(prototype, method, original => function () {
        if (!start.hasSubscribers || contexts.has(this)) return original.apply(this, arguments)
        const previous = currentQuery
        currentQuery = this
        try {
          return original.apply(this, arguments)
        } finally {
          currentQuery = previous
        }
      })
    }

    for (const owner of normalizers) {
      wrapped.push([owner, 'normalizeQuery', Object.getOwnPropertyDescriptor(owner, 'normalizeQuery')])
      shimmer.wrap(owner, 'normalizeQuery', original => function () {
        const result = original.apply(this, arguments)
        const query = currentQuery
        if (!query || contexts.has(query) || !start.hasSubscribers) return result
        try {
          const [statement, values] = result
          const info = this.connectionInfo
          const ctx = {
            statement,
            values,
            adapter: info?.adapter,
            hostname: info?.hostname,
            port: info?.port,
            database: info?.database ?? info?.filename,
            username: info?.username,
            // Bun's simple-protocol flag also covers unsafe queries without parameters.
            prepared: info?.prepare !== false && !(query[flagsSymbol] & 8),
          }
          contexts.set(query, ctx)
          return start.runStores(ctx, () => [ctx.statement, values])
        } catch (err) {
          contexts.delete(query)
          log.debug('Bun SQL query instrumentation failed: %s', err)
          return result
        }
      })
    }

    for (const method of ['resolve', 'reject']) {
      wrapped.push([prototype, method, Object.getOwnPropertyDescriptor(prototype, method)])
      shimmer.wrap(prototype, method, original => function (value) {
        const ctx = contexts.get(this)
        if (ctx) {
          contexts.delete(this)
          try {
            if (method === 'reject') {
              ctx.error = value
              error.publish(ctx)
            }
            finish.publish(ctx)
          } catch (err) {
            log.debug('Bun SQL query completion instrumentation failed: %s', err)
          }
        }
        return original.apply(this, arguments)
      })
    }
    channel('dd-trace:instrumentation:load').publish({ name: 'bun-sql' })
  } catch (err) {
    for (const [owner, method, descriptor] of wrapped.reverse()) {
      try {
        if (descriptor) Object.defineProperty(owner, method, descriptor)
        else delete owner[method]
      } catch (err) {
        log.debug('Restoring Bun SQL query method failed: %s', err)
      }
    }
    log.debug('Bun SQL instrumentation is unavailable: %s', err)
  }
}
