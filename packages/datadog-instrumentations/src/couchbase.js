'use strict'

const { AsyncResource } = require('async_hooks')
const {
  channel,
  addHook,
  bind,
  bindEventEmitter
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

addHook({ name: 'couchbase', file: 'lib/bucket.js', versions: ['^2.6.5'] }, Bucket => {
  const startChn1qlReq = channel('apm:couchbase:_n1qlReq:start')
  const asyncEndChn1qlReq = channel('apm:couchbase:_n1qlReq:async-end')
  const endChn1qlReq = channel('apm:couchbase:_n1qlReq:end')
  const errorChn1qlReq = channel('apm:couchbase:_n1qlReq:error')

  bindEventEmitter(Bucket.prototype)
  bindEventEmitter(Bucket.N1qlQueryResponse.prototype)

  shimmer.wrap(Bucket.prototype, '_maybeInvoke', _maybeInvoke => function (fn, args) {
    const ar = new AsyncResource('bound-anonymous-fn')
    if (!Array.isArray(args)) return _maybeInvoke.apply(this, arguments)

    const callbackIndex = args.length - 1
    const callback = args[callbackIndex]

    if (callback instanceof Function) {
      args[callbackIndex] = bind(callback)
    }

    return ar.runInAsyncScope(() => {
      return _maybeInvoke.apply(this, arguments)
    })
  })

  shimmer.wrap(Bucket.prototype, 'query', query => function (q, params, callback) {
    const ar = new AsyncResource('bound-anonymous-fn')
    callback = arguments[arguments.length - 1]

    if (typeof callback === 'function') {
      arguments[arguments.length - 1] = bind(callback)
    }

    return ar.runInAsyncScope(() => {
      return query.apply(this, arguments)
    })
  })

  shimmer.wrap(Bucket.prototype, '_n1qlReq', _n1qlReq => function (host, q, adhoc, emitter) {
    const ar = new AsyncResource('bound-anonymous-fn')
    if (
      !startChn1qlReq.hasSubscribers
    ) {
      return _n1qlReq.apply(this, arguments)
    }
    if (!emitter || !emitter.once) return _n1qlReq.apply(this, arguments)

    const n1qlQuery = q && q.statement

    startChn1qlReq.publish([n1qlQuery, this])

    emitter.once('rows', bind(() => {
      asyncEndChn1qlReq.publish(undefined)
    }))

    emitter.once('error', bind((error) => {
      errorChn1qlReq.publish(error)
      asyncEndChn1qlReq.publish(undefined)
    }))

    try {
      return ar.runInAsyncScope(() => {
        return _n1qlReq.apply(this, arguments)
      })
    } catch (err) {
      err.stack // trigger getting the stack at the original throwing point
      errorChn1qlReq.publish(err)

      throw err
    } finally {
      endChn1qlReq.publish(undefined)
    }
  })

  Bucket.prototype.upsert = wrap('apm:couchbase:upsert', Bucket.prototype.upsert)
  Bucket.prototype.insert = wrap('apm:couchbase:insert', Bucket.prototype.insert)
  Bucket.prototype.replace = wrap('apm:couchbase:replace', Bucket.prototype.replace)
  Bucket.prototype.append = wrap('apm:couchbase:append', Bucket.prototype.append)
  Bucket.prototype.prepend = wrap('apm:couchbase:prepend', Bucket.prototype.prepend)

  return Bucket
})

addHook({ name: 'couchbase', file: 'lib/cluster.js', versions: ['^2.6.5'] }, Cluster => {
  shimmer.wrap(Cluster.prototype, '_maybeInvoke', _maybeInvoke => function (fn, args) {
    const ar = new AsyncResource('bound-anonymous-fn')
    if (!Array.isArray(args)) return _maybeInvoke.apply(this, arguments)

    const callbackIndex = args.length - 1
    const callback = args[callbackIndex]

    if (callback instanceof Function) {
      args[callbackIndex] = bind(callback)
    }

    return ar.runInAsyncScope(() => {
      return _maybeInvoke.apply(this, arguments)
    })
  })

  shimmer.wrap(Cluster.prototype, 'query', query => function (q, params, callback) {
    const ar = new AsyncResource('bound-anonymous-fn')
    callback = arguments[arguments.length - 1]

    if (typeof callback === 'function') {
      arguments[arguments.length - 1] = bind(callback)
    }

    return ar.runInAsyncScope(() => {
      return query.apply(this, arguments)
    })
  })
  return Cluster
})

function findCallbackIndex (args) {
  for (let i = args.length - 1; i >= 2; i--) {
    if (typeof args[i] === 'function') return i
  }
  return -1
}

function wrap (prefix, fn) {
  const startCh = channel(prefix + ':start')
  const endCh = channel(prefix + ':end')
  const asyncEndCh = channel(prefix + ':async-end')
  const errorCh = channel(prefix + ':error')

  const wrapped = function (key, value, options, callback) {
    const ar = new AsyncResource('bound-anonymous-fn')
    if (
      !startCh.hasSubscribers
    ) {
      return fn.apply(this, arguments)
    }

    const callbackIndex = findCallbackIndex(arguments)

    if (callbackIndex < 0) return fn.apply(this, arguments)

    const cb = arguments[callbackIndex]

    startCh.publish([this])

    arguments[callbackIndex] = bind(function (error, result) {
      if (error) {
        errorCh.publish(error)
      }
      asyncEndCh.publish(result)
      return cb.apply(this, arguments)
    })

    try {
      return ar.runInAsyncScope(() => {
        return fn.apply(this, arguments)
      })
    } catch (error) {
      error.stack // trigger getting the stack at the original throwing point
      errorCh.publish(error)

      throw error
    } finally {
      endCh.publish(undefined)
    }
  }
  return shimmer.wrap(fn, wrapped)
}
