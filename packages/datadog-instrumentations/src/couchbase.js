'use strict'

const { AsyncResource, executionAsyncId, triggerAsyncId } = require('async_hooks')
const {
  channel,
  addHook,
  bind,
  bindAsyncResource,
  bindEventEmitter
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

addHook({ name: 'couchbase', file: 'lib/bucket.js', versions: ['^2.6.5'] }, Bucket => {
  debugger;
  const startChn1qlReq = channel('apm:couchbase:_n1qlReq:start')
  const asyncEndChn1qlReq = channel('apm:couchbase:_n1qlReq:async-end')
  const endChn1qlReq = channel('apm:couchbase:_n1qlReq:end')
  const errorChn1qlReq = channel('apm:couchbase:_n1qlReq:error')

  bindEventEmitter(Bucket.prototype)

  shimmer.wrap(Bucket.prototype, '_maybeInvoke', _maybeInvoke => function (fn, args) {
    debugger;
    
    const ar = new AsyncResource('bound-anonymous-fn')
    if (!Array.isArray(args)) return _maybeInvoke.apply(this, arguments)

    const callbackIndex = args.length - 1
    const callback = args[callbackIndex]
    console.log('bruhhhh')
    const id = executionAsyncId()
    
    if (callback instanceof Function) {
      
      console.log(id, triggerAsyncId())
      args[callbackIndex] = bind(callback)
    }
    // return _maybeInvoke.apply(this, arguments)
    
    
    return ar.runInAsyncScope(() => {
      _maybeInvoke.apply(this, arguments)
    })
  })

  shimmer.wrap(Bucket.prototype, 'query', query => function (q, params, callback) {
    debugger;
    const ar = new AsyncResource('bound-anonymous-fn')
    callback = arguments[arguments.length - 1]

    if (typeof callback === 'function') {
      arguments[arguments.length - 1] = bind(callback)
    }

    // return query.apply(this, arguments)
    return ar.runInAsyncScope(() => {
      query.apply(this, arguments)
    })
  })

  shimmer.wrap(Bucket.prototype, '_n1qlReq', _n1qlReq => function (host, q, adhoc, emitter) {
    debugger;
    const ar = new AsyncResource('bound-anonymous-fn')
    if (
      !startChn1qlReq.hasSubscribers
    ) {
      return fn.apply(this, arguments)
    }
    if (!emitter || !emitter.once) return _n1qlReq.apply(this, arguments)

    const n1qlQuery = q && q.statement

    startChn1qlReq.publish([n1qlQuery, this.config, this])

    const cb = bind(() => {
      asyncEndChn1qlReq.publish(undefined)
    })

    const cb2 = bind(error => {
      if (error) {
        errorChn1qlReq.publish(error)
      }
      asyncEndChn1qlReq.publish(undefined)
    })

    emitter.once('rows', cb)
    emitter.once('error', cb2)

    try {
      // return _n1qlReq.apply(this, arguments)
      // const id = executionAsyncId()
      // console.log(id)
      // return AsyncResource.bind(() => {
      //   console.log(triggerAsyncId())
      //   return _n1qlReq.apply(this, arguments)
      // })
      // return function () {
      //   return ar.runInAsyncScope(() => {
      //     return _n1qlReq.apply(this, arguments)
      //   })
      // }
      // _n1qlReq = bind(_n1qlReq)
      // return _n1qlReq.apply(this, arguments)
      debugger;
      // return AsyncResource.bind(_n1qlReq.apply(this, arguments))
      return ar.runInAsyncScope(() => {
        return _n1qlReq.apply(this, arguments)
      })
    } catch (err) {
      err.stack // trigger getting the stack at the original throwing point
      errorCh.publish(err)

      throw err
    } finally {
      endChn1qlReq.publish(undefined)
    }
    
  })
  debugger;
  if (Bucket.prototype.upsert) {
    Bucket.prototype.upsert = wrap('apm:couchbase:upsert', Bucket.prototype.upsert)
  }
  if (Bucket.prototype.insert) {
    Bucket.prototype.insert = wrap('apm:couchbase:insert', Bucket.prototype.insert)
  }
  if (Bucket.prototype.replace) {
    Bucket.prototype.replace = wrap('apm:couchbase:replace', Bucket.prototype.replace)
  }
  if (Bucket.prototype.append) {
    Bucket.prototype.append = wrap('apm:couchbase:append', Bucket.prototype.append)
  }
  if (Bucket.prototype.prepend) {
    Bucket.prototype.prepend = wrap('apm:couchbase:prepend', Bucket.prototype.prepend)
  }

  // bindEventEmitter(Bucket.prototype)
  return Bucket
})

addHook({ name: 'couchbase', file: 'lib/cluster.js', versions: ['^2.6.5'] }, Cluster => {
  // debugger;
  shimmer.wrap(Cluster.prototype, '_maybeInvoke', _maybeInvoke => function (fn, args) {
    debugger;
    const ar = new AsyncResource('bound-anonymous-fn')
    if (!Array.isArray(args)) return _maybeInvoke.apply(this, arguments)

    const callbackIndex = args.length - 1
    const callback = args[callbackIndex]

    if (callback instanceof Function) {
      args[callbackIndex] = bind(callback)
    }

    // return _maybeInvoke.apply(this, arguments)
    const id = executionAsyncId()
    return ar.runInAsyncScope(() => {
      console.log(id, executionAsyncId(), triggerAsyncId())
      return _maybeInvoke.apply(this, arguments)
    })
  })

  shimmer.wrap(Cluster.prototype, 'query', query => function (q, params, callback) {
    debugger;
    const ar = new AsyncResource('bound-anonymous-fn')
    callback = arguments[arguments.length - 1]

    if (typeof callback === 'function') {
      arguments[arguments.length - 1] = bind(callback)
    }

    // return query.apply(this, arguments)
    const id = executionAsyncId()
      
    return ar.runInAsyncScope(() => {
      console.log(id, executionAsyncId(),triggerAsyncId())
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
  debugger;
  const startCh = channel(prefix + ':start')
  const endCh = channel(prefix + ':end')
  const asyncEndCh = channel(prefix + ':async-end')
  const errorCh = channel(prefix + ':error')

  const wrapped = function (key, value, options, callback) {
    debugger;
    const ar = new AsyncResource('bound-anonymous-fn')
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
      // return fn.apply(this, arguments)
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
