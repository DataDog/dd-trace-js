'use strict'

const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')

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

function wrapAllNames (names, action) {
  for (const name of names) {
    action(name)
  }
}

function wrapCallbackFinish (callback, thisArg, _args, errorCh, finishCh, ctx, channelPrefix) {
  const callbackStartCh = channel(`${channelPrefix}:callback:start`)
  const callbackFinishCh = channel(`${channelPrefix}:callback:finish`)

  const wrapped = callbackStartCh.runStores(ctx, () => {
    return function finish (error, result) {
      return callbackFinishCh.runStores(ctx, () => {
        if (error) {
          ctx.error = error
          errorCh.publish(ctx)
        }
        finishCh.publish(ctx)
        return callback.apply(thisArg, [error, result])
      })
    }
  })
  Object.defineProperty(wrapped, '_dd_wrapped', { value: true })
  return wrapped
}

function wrapCBandPromise (fn, name, startData, thisArg, args) {
  const startCh = channel(`apm:couchbase:${name}:start`)
  const finishCh = channel(`apm:couchbase:${name}:finish`)
  const errorCh = channel(`apm:couchbase:${name}:error`)

  if (!startCh.hasSubscribers) return fn.apply(thisArg, args)

  const ctx = startData
  return startCh.runStores(ctx, () => {
    try {
      const cbIndex = findCallbackIndex(args, 1)
      if (cbIndex >= 0) {
        // v3 offers callback or promises event handling
        // NOTE: this does not work with v3.2.0-3.2.1 cluster.query, as there is a bug in the couchbase source code
        args[cbIndex] = shimmer.wrapFunction(args[cbIndex], (cb) => {
          return wrapCallbackFinish(cb, thisArg, args, errorCh, finishCh, ctx, `apm:couchbase:${name}`)
        })
      }
      const res = fn.apply(thisArg, args)

      // semver >=3 will always return promise by default
      res.then(
        (result) => {
          ctx.result = result
          finishCh.publish(ctx)
        },
        (err) => {
          ctx.error = err
          errorCh.publish(ctx)
          finishCh.publish(ctx)
        }
      )
      return res
    } catch (e) {
      void e.stack
      ctx.error = e
      errorCh.publish(ctx)
      throw e
    }
  })
}

function wrapWithName (name) {
  return function (operation) {
    return function (...args) { // no arguments used by us
      return wrapCBandPromise(operation, name, {
        collection: { name: this._name || '_default' },
        bucket: { name: this._scope._bucket._name },
        seedNodes: this._dd_connStr,
      }, this, args)
    }
  }
}

function wrapV3Query (query) {
  return function (q) {
    const resource = getQueryResource(q)
    return wrapCBandPromise(query, 'query', { resource, seedNodes: this._connStr }, this, arguments)
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
  wrapAllNames(['upsert', 'insert', 'replace'], name => {
    shimmer.wrap(Collection.prototype, name, wrapWithName(name))
  })
})

addHook({ name: 'couchbase', file: 'lib/cluster.js', versions: ['^3.0.7', '^3.1.3'] }, Cluster => {
  shimmer.wrap(Cluster.prototype, 'query', wrapV3Query)
})

// semver >=3.2.2
// NOTE: <3.2.2 segfaults on cluster.close() https://issues.couchbase.com/browse/JSCBC-936

addHook({ name: 'couchbase', file: 'dist/collection.js', versions: ['>=3.2.2'] }, collection => {
  const Collection = collection.Collection

  wrapAllNames(['upsert', 'insert', 'replace'], name => {
    shimmer.wrap(Collection.prototype, name, wrapWithName(name))
  })
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
