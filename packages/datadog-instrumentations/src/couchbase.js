'use strict'

const { errorMonitor } = require('events')
const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

// these channels are for maintaining store context for their respective methods
const callbackStartCh = channel('apm:couchbase:query:callback:start')
const callbackFinishCh = channel('apm:couchbase:query:callback:finish')

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

function wrapCallback (callback, ctx) {
  return callbackStartCh.runStores(ctx, function (...args) {
    return callbackFinishCh.runStores(ctx, () => {
      return callback.apply(this, args)
    })
  })
}

function wrapQuery (query) {
  return function (q, params, callback) {
    const cb = arguments[arguments.length - 1]
    if (typeof cb === 'function') {
      const ctx = {}
      arguments[arguments.length - 1] = wrapCallback(cb, ctx)
    }

    return query.apply(this, arguments)
  }
}

function wrapCallbackFinish (callback, thisArg, _args, errorCh, finishCh, ctx) {
  return callbackStartCh.runStores(ctx, () => {
    return function finish (error, result) {
      return callbackFinishCh.runStores(ctx, () => {
        if (error) {
          ctx.error = error
          errorCh.publish(ctx)
        }
        return finishCh.runStores(ctx, () => callback.apply(thisArg, [error, result]))
      })
    }
  })
}

function wrap (prefix, fn) {
  const startCh = channel(prefix + ':start')
  const finishCh = channel(prefix + ':finish')
  const errorCh = channel(prefix + ':error')

  const wrapped = function () {
    if (!startCh.hasSubscribers) {
      return fn.apply(this, arguments)
    }

    const callbackIndex = findCallbackIndex(arguments, 1)

    if (callbackIndex < 0) return fn.apply(this, arguments)

    const ctx = { bucket: { name: this.name || this._name }, seedNodes: this._dd_hosts }
    return startCh.runStores(ctx, () => {
      const cb = arguments[callbackIndex]

      arguments[callbackIndex] = shimmer.wrapFunction(cb, (cb) => {
        return wrapCallbackFinish(cb, this, arguments, errorCh, finishCh, ctx)
      })

      try {
        return fn.apply(this, arguments)
      } catch (error) {
        ctx.error = error
        error.stack // trigger getting the stack at the original throwing point
        errorCh.publish(ctx)

        throw error
      }
    })
  }
  return wrapped
}

// semver >=3

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
          return wrapCallbackFinish(cb, thisArg, args, errorCh, finishCh, ctx)
        })
      }
      const res = fn.apply(thisArg, args)

      // semver >=3 will always return promise by default
      callbackStartCh.runStores(ctx, () => {
        res.then(
          (result) => {
            callbackFinishCh.runStores(ctx, () => {
              ctx.result = result
              finishCh.publish(ctx)
            })
          },
          (err) => {
            callbackFinishCh.runStores(ctx, () => {
              ctx.error = err
              errorCh.publish(ctx)
              finishCh.publish(ctx)
            })
          }
        )
      })
      return res
    } catch (e) {
      e.stack
      ctx.error = e
      errorCh.publish(ctx)
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

  shimmer.wrap(Bucket.prototype, 'query', query => wrapQuery(query))

  shimmer.wrap(Bucket.prototype, '_n1qlReq', _n1qlReq => function (host, q, adhoc, emitter) {
    if (!startCh.hasSubscribers) {
      return _n1qlReq.apply(this, arguments)
    }

    if (!emitter || !emitter.once) return _n1qlReq.apply(this, arguments)

    const n1qlQuery = getQueryResource(q)

    const ctx = { resource: n1qlQuery, bucket: { name: this.name || this._name }, seedNodes: this._dd_hosts }
    return startCh.runStores(ctx, () => {
      callbackStartCh.runStores(ctx, () => {
        emitter.once('rows', () => {
          callbackFinishCh.runStores(ctx, () => {
            finishCh.publish(ctx)
          })
        })

        emitter.once(errorMonitor, (error) => {
          if (!error) return
          callbackFinishCh.runStores(ctx, () => {
            ctx.error = error
            errorCh.publish(ctx)
            finishCh.publish(ctx)
          })
        })
      })

      try {
        return _n1qlReq.apply(this, arguments)
      } catch (err) {
        err.stack // trigger getting the stack at the original throwing point
        ctx.error = err
        errorCh.publish(ctx)

        throw err
      }
    })
  })

  wrapAllNames(['upsert', 'insert', 'replace', 'append', 'prepend'], name => {
    shimmer.wrap(Bucket.prototype, name, fn => wrap(`apm:couchbase:${name}`, fn))
  })

  return Bucket
})

addHook({ name: 'couchbase', file: 'lib/cluster.js', versions: ['^2.6.12'] }, Cluster => {
  const startCh = channel('apm:couchbase:query:start')
  const finishCh = channel('apm:couchbase:query:finish')
  const errorCh = channel('apm:couchbase:query:error')

  shimmer.wrap(Cluster.prototype, 'query', query => wrapQuery(query))

  shimmer.wrap(Cluster.prototype, '_n1ql', _n1ql => function (host, q, adhoc, emitter) {
    if (!startCh.hasSubscribers) {
      return _n1ql.apply(this, arguments)
    }
    if (!emitter || !emitter.once) return _n1ql.apply(this, arguments)

    const n1qlQuery = getQueryResource(q)

    const hosts = this.dsnObj.hosts
    const seedNodes = hosts.map(hostAndPort => hostAndPort.join(':')).join(',')

    const ctx = { resource: n1qlQuery, seedNodes }
    return startCh.runStores(ctx, () => {
      callbackStartCh.runStores(ctx, () => {
        emitter.once('rows', () => {
          callbackFinishCh.runStores(ctx, () => {
            finishCh.publish(ctx)
          })
        })

        emitter.once(errorMonitor, (error) => {
          if (!error) return
          callbackFinishCh.runStores(ctx, () => {
            ctx.error = error
            errorCh.publish(ctx)
            finishCh.publish(ctx)
          })
        })
      })

      try {
        return _n1ql.apply(this, arguments)
      } catch (err) {
        err.stack // trigger getting the stack at the original throwing point
        ctx.error = err
        errorCh.publish(ctx)

        throw err
      }
    })
  })

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
