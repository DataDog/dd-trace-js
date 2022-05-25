'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

addHook({ name: 'couchbase', file: 'lib/bucket.js', versions: ['^2.6.5'] }, Bucket => {
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

    const n1qlQuery = q && q.statement

    const asyncResource = new AsyncResource('bound-anonymous-fn')
    return asyncResource.runInAsyncScope(() => {
      startCh.publish({ resource: n1qlQuery, bucket: this })

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

  Bucket.prototype.upsert = wrap('apm:couchbase:upsert', Bucket.prototype.upsert)
  Bucket.prototype.insert = wrap('apm:couchbase:insert', Bucket.prototype.insert)
  Bucket.prototype.replace = wrap('apm:couchbase:replace', Bucket.prototype.replace)
  Bucket.prototype.append = wrap('apm:couchbase:append', Bucket.prototype.append)
  Bucket.prototype.prepend = wrap('apm:couchbase:prepend', Bucket.prototype.prepend)

  return Bucket
})

addHook({ name: 'couchbase', file: 'lib/cluster.js', versions: ['^2.6.5'] }, Cluster => {
  Cluster.prototype._maybeInvoke = wrapMaybeInvoke(Cluster.prototype._maybeInvoke)
  Cluster.prototype.query = wrapQuery(Cluster.prototype.query)

  return Cluster
})

function findCallbackIndex (args) {
  for (let i = args.length - 1; i >= 2; i--) {
    if (typeof args[i] === 'function') return i
  }
  return -1
}

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

  const wrapped = function (key, value, options, callback) {
    if (!startCh.hasSubscribers) {
      return fn.apply(this, arguments)
    }

    const callbackIndex = findCallbackIndex(arguments)

    if (callbackIndex < 0) return fn.apply(this, arguments)

    const callbackResource = new AsyncResource('bound-anonymous-fn')
    const asyncResource = new AsyncResource('bound-anonymous-fn')

    return asyncResource.runInAsyncScope(() => {
      const cb = callbackResource.bind(arguments[callbackIndex])

      startCh.publish({ bucket: this })

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
