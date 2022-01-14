'use strict'

const { AsyncResource } = require('async_hooks')
const {
  channel,
  addHook,
  bind,
  bindAsyncResource,
  bindEventEmitter
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

addHook({ name: 'couchbase', file: 'lib/bucket.js', versions: ['^2.6.5'] }, Bucket => {
  const startChn1qlReq = channel('apm:couchbase:_n1qlReq:start')
  const asyncEndChn1qlReq = channel('apm:couchbase:_n1qlReq:async-end')
  const endChn1qlReq = channel('apm:couchbase:_n1qlReq:end')
  const errorChn1qlReq = channel('apm:couchbase:_n1qlReq:error')

  bindEventEmitter(Bucket.prototype)

  shimmer.wrap(Bucket.prototype, '_maybeInvoke', _maybeInvoke => function (fn, args) {
    if (!Array.isArray(args)) return _maybeInvoke.apply(this, arguments)

    const callbackIndex = args.length - 1
    const callback = args[callbackIndex]

    if (callback instanceof Function) {
      args[callbackIndex] = bind(callback)
    }

    return _maybeInvoke.apply(this, arguments)
  })

  shimmer.wrap(Bucket.prototype, 'query', query => function (q, params, callback) {
    callback = arguments[arguments.length - 1]

    if (typeof callback === 'function') {
      arguments[arguments.length - 1] = bind(callback)
    }

    return query.apply(this, arguments)
  })

  shimmer.wrap(Bucket.prototype, '_n1qlReq', _n1qlReq => function (host, q, adhoc, emitter) {
    if (
      !startCh.hasSubscribers
    ) {
      return fn.apply(this, arguments)
    }
    if (!emitter || !emitter.once) return _n1qlReq.apply(this, arguments)

    const n1qlQuery = q && q.statement

    startChn1qlReq.publish([n1qlQuery, this.config, this])

    const cb = bind(function () {
      asyncEndChn1qlReq.publish(undefined)
    })

    const cb2 = bind(error => errorChn1qlReq.publish(error))

    emitter.once('rows', cb)
    emitter.once('error', cb2)

    return _n1qlReq.apply(this, arguments)
  })

  Bucket.upsert = wrap('apm:couchbase:upsert', Bucket.upsert)
  Bucket.insert = wrap('apm:couchbase:insert', Bucket.insert)
  Bucket.replace = wrap('apm:couchbase:replace', Bucket.replace)
  Bucket.append = wrap('apm:couchbase:append', Bucket.append)
  Bucket.prepend = wrap('apm:couchbase:prepend', Bucket.prepend)

  return Bucket
})

addHook({ name: 'couchbase', file: 'lib/cluster.js', versions: ['^2.6.5'] }, Cluster => {
  shimmer.wrap(Cluster.prototype, '_maybeInvoke', _maybeInvoke => function (fn, args) {
    if (!Array.isArray(args)) return _maybeInvoke.apply(this, arguments)

    const callbackIndex = args.length - 1
    const callback = args[callbackIndex]

    if (callback instanceof Function) {
      args[callbackIndex] = bind(callback)
    }

    return _maybeInvoke.apply(this, arguments)
  })

  shimmer.wrap(Cluster.prototype, 'query', query => function (q, params, callback) {
    callback = arguments[arguments.length - 1]

    if (typeof callback === 'function') {
      arguments[arguments.length - 1] = bind(callback)
    }

    return query.apply(this, arguments)
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
    if (
      !startCh.hasSubscribers
    ) {
      return fn.apply(this, arguments)
    }

    const callbackIndex = findCallbackIndex(arguments)

    if (callbackIndex < 0) return fn.apply(this, arguments)

    const cb = bind(arguments[callbackIndex])

    startCh.publish([this])

    arguments[callbackIndex] = function (error, result) {
      if (error) {
        errorCh.publish(error)
      }
      asyncEndCh.publish(result)
      cb.apply(this, arguments)
    }

    try {
      return fn.apply(this, arguments)
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
