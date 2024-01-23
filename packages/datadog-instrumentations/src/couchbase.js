'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

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
  names.forEach(name => action(name))
}

// semver >=2 <3
function wrapMaybeInvoke (_maybeInvoke) {
  const wrapped = function (fn, args) {
    if (!Array.isArray(args)) return _maybeInvoke.apply(this, arguments)

    const callbackIndex = args.length - 1
    const callback = args[callbackIndex]

    if (callback instanceof Function) {
      args[callbackIndex] = AsyncResource.bind(callback)
    }

    return _maybeInvoke.apply(this, arguments)
  }
  return shimmer.wrap(_maybeInvoke, wrapped)
}

function wrapQuery (query) {
  const wrapped = function (q, params, callback) {
    callback = AsyncResource.bind(arguments[arguments.length - 1])

    if (typeof callback === 'function') {
      arguments[arguments.length - 1] = callback
    }

    const res = query.apply(this, arguments)
    return res
  }
  return shimmer.wrap(query, wrapped)
}

function wrap (prefix, fn) {
  const startCh = channel(prefix + ':start')
  const finishCh = channel(prefix + ':finish')
  const errorCh = channel(prefix + ':error')

  const wrapped = function () {
    if (!startCh.hasSubscribers) {
      return fn.apply(this, arguments)
    }

    const callbackIndex = findCallbackIndex(arguments)

    if (callbackIndex < 0) return fn.apply(this, arguments)

    const callbackResource = new AsyncResource('bound-anonymous-fn')
    const asyncResource = new AsyncResource('bound-anonymous-fn')

    return asyncResource.runInAsyncScope(() => {
      const cb = callbackResource.bind(arguments[callbackIndex])

      startCh.publish({ bucket: { name: this.name || this._name }, seedNodes: this._dd_hosts })

      arguments[callbackIndex] = asyncResource.bind(function (error, result) {
        if (error) {
          errorCh.publish(error)
        }
        finishCh.publish(result)
        return cb.apply(this, arguments)
      })

      try {
        return fn.apply(this, arguments)
      } catch (error) {
        error.stack // trigger getting the stack at the original throwing point
        errorCh.publish(error)

        throw error
      }
    })
  }
  return shimmer.wrap(fn, wrapped)
}

// semver >=3

function wrapCBandPromise (fn, name, startData, thisArg, args) {
  const startCh = channel(`apm:couchbase:${name}:start`)
  const finishCh = channel(`apm:couchbase:${name}:finish`)
  const errorCh = channel(`apm:couchbase:${name}:error`)

  if (!startCh.hasSubscribers) return fn.apply(thisArg, args)

  const asyncResource = new AsyncResource('bound-anonymous-fn')
  const callbackResource = new AsyncResource('bound-anonymous-fn')

  return asyncResource.runInAsyncScope(() => {
    startCh.publish(startData)

    try {
      const cbIndex = findCallbackIndex(args, 1)
      if (cbIndex >= 0) {
        // v3 offers callback or promises event handling
        // NOTE: this does not work with v3.2.0-3.2.1 cluster.query, as there is a bug in the couchbase source code
        const cb = callbackResource.bind(args[cbIndex])
        args[cbIndex] = asyncResource.bind(function (error, result) {
          if (error) {
            errorCh.publish(error)
          }
          finishCh.publish({ result })
          return cb.apply(thisArg, arguments)
        })
      }
      const res = fn.apply(thisArg, args)

      // semver >=3 will always return promise by default
      res.then(
        asyncResource.bind((result) => finishCh.publish({ result })),
        asyncResource.bind((err) => errorCh.publish(err)))
      return res
    } catch (e) {
      e.stack
      errorCh.publish(e)
      throw e
    }
  })
}

function wrapWithName (name) {
  return function (operation) {
    return function () { // no arguments used by us
      return wrapCBandPromise(operation, name, {
        collection: { name: this._name || '_default' },
        bucket: { name: this._scope._bucket._name },
        seedNodes: this._dd_connStr
      }, this, arguments)
    }
  }
}

function wrapV3Query (query) {
  return function (q) {
    const resource = getQueryResource(q)
    return wrapCBandPromise(query, 'query', { resource, seedNodes: this._connStr }, this, arguments)
  }
}

// semver >=2 <3
addHook({ name: 'couchbase', file: 'lib/bucket.js', versions: ['^2.6.12'] }, Bucket => {
  const startCh = channel('apm:couchbase:query:start')
  const finishCh = channel('apm:couchbase:query:finish')
  const errorCh = channel('apm:couchbase:query:error')

  Bucket.prototype._maybeInvoke = wrapMaybeInvoke(Bucket.prototype._maybeInvoke)
  Bucket.prototype.query = wrapQuery(Bucket.prototype.query)

  shimmer.wrap(Bucket.prototype, '_n1qlReq', _n1qlReq => function (host, q, adhoc, emitter) {
    if (!startCh.hasSubscribers) {
      return _n1qlReq.apply(this, arguments)
    }

    if (!emitter || !emitter.once) return _n1qlReq.apply(this, arguments)

    const n1qlQuery = getQueryResource(q)

    const asyncResource = new AsyncResource('bound-anonymous-fn')
    return asyncResource.runInAsyncScope(() => {
      startCh.publish({ resource: n1qlQuery, bucket: { name: this.name || this._name }, seedNodes: this._dd_hosts })

      emitter.once('rows', asyncResource.bind(() => {
        finishCh.publish(undefined)
      }))

      emitter.once('error', asyncResource.bind((error) => {
        errorCh.publish(error)
        finishCh.publish(undefined)
      }))

      try {
        return _n1qlReq.apply(this, arguments)
      } catch (err) {
        err.stack // trigger getting the stack at the original throwing point
        errorCh.publish(err)

        throw err
      }
    })
  })

  wrapAllNames(['upsert', 'insert', 'replace', 'append', 'prepend'], name => {
    Bucket.prototype[name] = wrap(`apm:couchbase:${name}`, Bucket.prototype[name])
  })

  return Bucket
})

addHook({ name: 'couchbase', file: 'lib/cluster.js', versions: ['^2.6.12'] }, Cluster => {
  Cluster.prototype._maybeInvoke = wrapMaybeInvoke(Cluster.prototype._maybeInvoke)
  Cluster.prototype.query = wrapQuery(Cluster.prototype.query)

  shimmer.wrap(Cluster.prototype, 'openBucket', openBucket => {
    return function () {
      const bucket = openBucket.apply(this, arguments)
      const hosts = this.dsnObj.hosts
      bucket._dd_hosts = hosts.map(hostAndPort => hostAndPort.join(':')).join(',')
      return bucket
    }
  })
  return Cluster
})

// semver >=3 <3.2.0

addHook({ name: 'couchbase', file: 'lib/bucket.js', versions: ['^3.0.7', '^3.1.3'] }, Bucket => {
  shimmer.wrap(Bucket.prototype, 'collection', getCollection => {
    return function () {
      const collection = getCollection.apply(this, arguments)
      const connStr = this._cluster._connStr
      collection._dd_connStr = connStr
      return collection
    }
  })

  return Bucket
})

addHook({ name: 'couchbase', file: 'lib/collection.js', versions: ['^3.0.7', '^3.1.3'] }, Collection => {
  wrapAllNames(['upsert', 'insert', 'replace'], name => {
    shimmer.wrap(Collection.prototype, name, wrapWithName(name))
  })

  return Collection
})

addHook({ name: 'couchbase', file: 'lib/cluster.js', versions: ['^3.0.7', '^3.1.3'] }, Cluster => {
  shimmer.wrap(Cluster.prototype, 'query', wrapV3Query)
  return Cluster
})

// semver >=3.2.2
// NOTE: <3.2.2 segfaults on cluster.close() https://issues.couchbase.com/browse/JSCBC-936

addHook({ name: 'couchbase', file: 'dist/collection.js', versions: ['>=3.2.2'] }, collection => {
  const Collection = collection.Collection

  wrapAllNames(['upsert', 'insert', 'replace'], name => {
    shimmer.wrap(Collection.prototype, name, wrapWithName(name))
  })

  return collection
})

addHook({ name: 'couchbase', file: 'dist/bucket.js', versions: ['>=3.2.2'] }, bucket => {
  const Bucket = bucket.Bucket
  shimmer.wrap(Bucket.prototype, 'collection', getCollection => {
    return function () {
      const collection = getCollection.apply(this, arguments)
      const connStr = this._cluster._connStr
      collection._dd_connStr = connStr
      return collection
    }
  })

  return bucket
})

addHook({ name: 'couchbase', file: 'dist/cluster.js', versions: ['>=3.2.2'] }, (cluster) => {
  const Cluster = cluster.Cluster

  shimmer.wrap(Cluster.prototype, 'query', wrapV3Query)
  return cluster
})
