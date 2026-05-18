'use strict'

const { tracingChannel } = require('dc-polyfill')

const shimmer = require('../../datadog-shimmer')
const {
  addHook,
} = require('./helpers/instrument')

// One TracingChannel per traced operation, looked up at module init so the
// hot path only does property reads on a stable handle.
const queryCh = tracingChannel('apm:couchbase:query')
const upsertCh = tracingChannel('apm:couchbase:upsert')
const insertCh = tracingChannel('apm:couchbase:insert')
const replaceCh = tracingChannel('apm:couchbase:replace')

/** @type {Map<string, ReturnType<typeof tracingChannel>>} */
const opChannelByName = new Map([
  ['query', queryCh],
  ['upsert', upsertCh],
  ['insert', insertCh],
  ['replace', replaceCh],
])

function findCallbackIndex (args, lowerbound = 2) {
  for (let i = args.length - 1; i >= lowerbound; i--) {
    if (typeof args[i] === 'function') return i
  }
  return -1
}

// handles n1ql and string queries
function getQueryResource (q) {
  return q && (typeof q === 'string' ? q : q.statement)
}

// Hand-rolled instead of `tracingChannel.tracePromise`: synchronous
// `res.then(...)` dodges the `Promise.resolve(thenable)` microtask race on
// SDK v3.2.x / v4.0-v4.4 (lazy listener attachment), and external `.on()`
// is forbidden on v4.5.0+ (JSCBC-1301 depromisify). See commit body.
/**
 * @param {import('node:diagnostics_channel').TracingChannel} ch
 *   Pinned per-op channel.
 * @param {(...callArgs: unknown[]) => unknown} fn The SDK method being traced.
 * @param {object} ctx Mutated to record `result` / `error`.
 * @param {object} thisArg
 * @param {unknown[]} args Forwarded to `fn` verbatim.
 */
function traceV3 (ch, fn, ctx, thisArg, args) {
  if (!ch.start.hasSubscribers) return fn.apply(thisArg, args)
  const cbIndex = findCallbackIndex(args, 1)
  if (cbIndex >= 0) {
    return ch.traceCallback(fn, cbIndex, ctx, thisArg, ...args)
  }
  return ch.start.runStores(ctx, () => {
    try {
      const res = fn.apply(thisArg, args)
      res.then(
        (result) => {
          ctx.result = result
          ch.asyncStart.publish(ctx)
          ch.asyncEnd.publish(ctx)
        },
        (error) => {
          ctx.error = error
          ch.error.publish(ctx)
          ch.asyncStart.publish(ctx)
          ch.asyncEnd.publish(ctx)
        }
      )
      return res
    } catch (error) {
      ctx.error = error
      ch.error.publish(ctx)
      throw error
    } finally {
      ch.end.publish(ctx)
    }
  })
}

/**
 * @param {string} name Operation name (`upsert`, `insert`, `replace`).
 */
function wrapV3WithName (name) {
  const ch = opChannelByName.get(name)
  return function (operation) {
    return function (...args) {
      const ctx = {
        collection: { name: this._name || '_default' },
        bucket: { name: this._scope._bucket._name },
        seedNodes: this._dd_connStr,
      }
      return traceV3(ch, operation, ctx, this, args)
    }
  }
}

/**
 * @param {(...args: unknown[]) => unknown} query Original `Cluster.prototype.query`.
 */
function wrapV3Query (query) {
  return function (...args) {
    const ctx = { resource: getQueryResource(args[0]), seedNodes: this._connStr }
    return traceV3(queryCh, query, ctx, this, args)
  }
}

// semver >=3 <3.2.0

addHook({ name: 'couchbase', file: 'lib/bucket.js', versions: ['^3.0.7', '^3.1.3'] }, Bucket => {
  shimmer.wrap(Bucket.prototype, 'collection', getCollection => {
    return function (...args) {
      const collection = getCollection.apply(this, args)
      const connStr = this._cluster._connStr
      collection._dd_connStr = connStr
      return collection
    }
  })
})

addHook({ name: 'couchbase', file: 'lib/collection.js', versions: ['^3.0.7', '^3.1.3'] }, Collection => {
  for (const name of ['upsert', 'insert', 'replace']) {
    shimmer.wrap(Collection.prototype, name, wrapV3WithName(name))
  }
})

addHook({ name: 'couchbase', file: 'lib/cluster.js', versions: ['^3.0.7', '^3.1.3'] }, Cluster => {
  shimmer.wrap(Cluster.prototype, 'query', wrapV3Query)
})

// semver >=3.2.2
// NOTE: <3.2.2 segfaults on cluster.close() https://issues.couchbase.com/browse/JSCBC-936

addHook({ name: 'couchbase', file: 'dist/collection.js', versions: ['>=3.2.2'] }, collection => {
  const Collection = collection.Collection

  for (const name of ['upsert', 'insert', 'replace']) {
    shimmer.wrap(Collection.prototype, name, wrapV3WithName(name))
  }
})

addHook({ name: 'couchbase', file: 'dist/bucket.js', versions: ['>=3.2.2'] }, bucket => {
  const Bucket = bucket.Bucket
  shimmer.wrap(Bucket.prototype, 'collection', getCollection => {
    return function (...args) {
      const collection = getCollection.apply(this, args)
      const connStr = this._cluster._connStr
      collection._dd_connStr = connStr
      return collection
    }
  })
})

addHook({ name: 'couchbase', file: 'dist/cluster.js', versions: ['>=3.2.2'] }, (cluster) => {
  const Cluster = cluster.Cluster

  shimmer.wrap(Cluster.prototype, 'query', wrapV3Query)
})
