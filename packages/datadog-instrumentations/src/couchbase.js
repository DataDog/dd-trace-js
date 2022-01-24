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
  // debugger;
  const startChn1qlReq = channel('apm:couchbase:_n1qlReq:start')
  const asyncEndChn1qlReq = channel('apm:couchbase:_n1qlReq:async-end')
  const endChn1qlReq = channel('apm:couchbase:_n1qlReq:end')
  const errorChn1qlReq = channel('apm:couchbase:_n1qlReq:error')
  
  // Bucket.prototype.upsert = wrap('apm:couchbase:upsert', Bucket.prototype.upsert, ar)
  // Bucket.prototype.insert = wrap('apm:couchbase:insert', Bucket.prototype.insert, ar)
  // Bucket.prototype.replace = wrap('apm:couchbase:replace', Bucket.prototype.replace, ar)
  // Bucket.prototype.append = wrap('apm:couchbase:append', Bucket.prototype.append, ar)
  // Bucket.prototype.prepend = wrap('apm:couchbase:prepend', Bucket.prototype.prepend, ar)

  const startChUpsert = channel('apm:couchbase:upsert:start')
  const asyncEndChUpsert = channel('apm:couchbase:upsert:async-end')
  const endChUpsert = channel('apm:couchbase:upsert:end')
  const errorChUpsert = channel('apm:couchbase:upsert:error')

  const startChInsert = channel('apm:couchbase:insert:start')
  const asyncEndChInsert = channel('apm:couchbase:insert:async-end')
  const endChInsert = channel('apm:couchbase:insert:end')
  const errorChInsert = channel('apm:couchbase:insert:error')

  const startChReplace = channel('apm:couchbase:replace:start')
  const asyncEndChReplace = channel('apm:couchbase:replace:async-end')
  const endChReplace = channel('apm:couchbase:replace:end')
  const errorChReplace = channel('apm:couchbase:replace:error')

  const startChAppend = channel('apm:couchbase:append:start')
  const asyncEndChAppend = channel('apm:couchbase:append:async-end')
  const endChAppend = channel('apm:couchbase:append:end')
  const errorChAppend = channel('apm:couchbase:append:error')

  const startChPrepend = channel('apm:couchbase:prepend:start')
  const asyncEndChPrepend = channel('apm:couchbase:prepend:async-end')
  const endChPrepend = channel('apm:couchbase:prepend:end')
  const errorChPrepend = channel('apm:couchbase:prepend:error')

  debugger;
  bindEventEmitter(Bucket.prototype)
  bindEventEmitter(Bucket.N1qlQueryResponse.prototype)
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
      return _maybeInvoke.apply(this, arguments)
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
      // return query.apply(this, arguments)
      const res = query.apply(this, arguments)
      bindEventEmitter(res)
      return res
    })
  })

  shimmer.wrap(Bucket.prototype, '_n1qlReq', _n1qlReq => function (host, q, adhoc, emitter) {
    debugger;
    const ar = new AsyncResource('bound-anonymous-fn')
    if (
      !startChn1qlReq.hasSubscribers
    ) {
      return  _n1qlReq.apply(this, arguments)
    }
    if (!emitter || !emitter.once) return _n1qlReq.apply(this, arguments)

    const n1qlQuery = q && q.statement

    startChn1qlReq.publish([n1qlQuery, this.config, this])
    
    debugger;
    let id2 = executionAsyncId()
    emitter.once('rows', bind(() => {
      debugger;
      // console.log('soso', id2, triggerAsyncId())
      asyncEndChn1qlReq.publish(undefined)
    }))
    id2 = executionAsyncId()
    emitter.once('error', bind((error) => {
      debugger;
      // console.log('ok', id2, triggerAsyncId())
      errorChn1qlReq.publish(error)
      asyncEndChn1qlReq.publish(undefined)
    }))

    // bindEventEmitter(emitter)

    try {
      debugger;
      // return AsyncResource.bind(_n1qlReq.apply(this, arguments))
      const id = executionAsyncId()
      
      
      return ar.runInAsyncScope(() => {
        console.log('blah', id, triggerAsyncId())
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
  
  shimmer.wrap(Bucket.prototype, 'upsert', upsert => function (key, value, options, callback) {
    debugger;
    const ar = new AsyncResource('bound-anonymous-fn')
    if (
      !startChUpsert.hasSubscribers
    ) {
      return upsert.apply(this, arguments)
    }

    const callbackIndex = findCallbackIndex(arguments)

    if (callbackIndex < 0) return upsert.apply(this, arguments)

    const cb = bind(arguments[callbackIndex])

    startChUpsert.publish([this])

    arguments[callbackIndex] = bind(function (error, result) {
      if (error) {
        errorChUpsert.publish(error)
      }
      asyncEndChUpsert.publish(result)
      return cb.apply(this, arguments)
    })

    try {
      // return fn.apply(this, arguments)
      return ar.runInAsyncScope(() => {
        return upsert.apply(this, arguments)
      })
    } catch (error) {
      error.stack // trigger getting the stack at the original throwing point
      errorChUpsert.publish(error)

      throw error
    } finally {
      endChUpsert.publish(undefined)
    }
  })
  shimmer.wrap(Bucket.prototype, 'insert', insert => function (key, value, options, callback) {
    debugger;
    const ar = new AsyncResource('bound-anonymous-fn')
    if (
      !startChInsert.hasSubscribers
    ) {
      return insert.apply(this, arguments)
    }

    const callbackIndex = findCallbackIndex(arguments)

    if (callbackIndex < 0) return insert.apply(this, arguments)

    const cb = bind(arguments[callbackIndex])

    startChInsert.publish([this])

    arguments[callbackIndex] = bind(function (error, result) {
      if (error) {
        errorChInsert.publish(error)
      }
      asyncEndChInsert.publish(result)
      return cb.apply(this, arguments)
    })

    try {
      // return fn.apply(this, arguments)
      return ar.runInAsyncScope(() => {
        return insert.apply(this, arguments)
      })
    } catch (error) {
      error.stack // trigger getting the stack at the original throwing point
      errorChInsert.publish(error)

      throw error
    } finally {
      endChInsert.publish(undefined)
    }
  })
  shimmer.wrap(Bucket.prototype, 'replace', replace => function (key, value, options, callback) {
    debugger;
    const ar = new AsyncResource('bound-anonymous-fn')
    if (
      !startChReplace.hasSubscribers
    ) {
      return replace.apply(this, arguments)
    }

    const callbackIndex = findCallbackIndex(arguments)

    if (callbackIndex < 0) return replace.apply(this, arguments)

    const cb = bind(arguments[callbackIndex])

    startChReplace.publish([this])

    arguments[callbackIndex] = bind(function (error, result) {
      if (error) {
        errorChReplace.publish(error)
      }
      asyncEndChReplace.publish(result)
      return cb.apply(this, arguments)
    })

    try {
      // return fn.apply(this, arguments)
      return ar.runInAsyncScope(() => {
        return replace.apply(this, arguments)
      })
    } catch (error) {
      error.stack // trigger getting the stack at the original throwing point
      errorChReplace.publish(error)

      throw error
    } finally {
      endChReplace.publish(undefined)
    }
  })
  shimmer.wrap(Bucket.prototype, 'append', append => function (key, value, options, callback) {
    debugger;
    const ar = new AsyncResource('bound-anonymous-fn')
    if (
      !startChAppend.hasSubscribers
    ) {
      return append.apply(this, arguments)
    }

    const callbackIndex = findCallbackIndex(arguments)

    if (callbackIndex < 0) return append.apply(this, arguments)

    const cb = bind(arguments[callbackIndex])

    startChAppend.publish([this])

    arguments[callbackIndex] = bind(function (error, result) {
      if (error) {
        errorChAppend.publish(error)
      }
      asyncEndChAppend.publish(result)
      return cb.apply(this, arguments)
    })

    try {
      // return fn.apply(this, arguments)
      return ar.runInAsyncScope(() => {
        return append.apply(this, arguments)
      })
    } catch (error) {
      error.stack // trigger getting the stack at the original throwing point
      errorChAppend.publish(error)

      throw error
    } finally {
      endChAppend.publish(undefined)
    }
  })
  shimmer.wrap(Bucket.prototype, 'prepend', prepend => function (key, value, options, callback) {
    debugger;
    const ar = new AsyncResource('bound-anonymous-fn')
    if (
      !startChPrepend.hasSubscribers
    ) {
      return prepend.apply(this, arguments)
    }

    const callbackIndex = findCallbackIndex(arguments)

    if (callbackIndex < 0) return prepend.apply(this, arguments)

    const cb = bind(arguments[callbackIndex])

    startChPrepend.publish([this])

    arguments[callbackIndex] = bind(function (error, result) {
      if (error) {
        errorChPrepend.publish(error)
      }
      asyncEndChPrepend.publish(result)
      return cb.apply(this, arguments)
    })

    try {
      // return fn.apply(this, arguments)
      return ar.runInAsyncScope(() => {
        return prepend.apply(this, arguments)
      })
    } catch (error) {
      error.stack // trigger getting the stack at the original throwing point
      errorChPrepend.publish(error)

      throw error
    } finally {
      endChPrepend.publish(undefined)
    }
  })
  // Bucket.prototype.upsert = wrap('apm:couchbase:upsert', Bucket.prototype.upsert, ar)
  // Bucket.prototype.insert = wrap('apm:couchbase:insert', Bucket.prototype.insert, ar)
  // Bucket.prototype.replace = wrap('apm:couchbase:replace', Bucket.prototype.replace, ar)
  // Bucket.prototype.append = wrap('apm:couchbase:append', Bucket.prototype.append, ar)
  // Bucket.prototype.prepend = wrap('apm:couchbase:prepend', Bucket.prototype.prepend, ar)
  

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
      // console.log(id, executionAsyncId(),triggerAsyncId())
      // return query.apply(this, arguments)
      const res = query.apply(this, arguments)
      bindEventEmitter(res)
      return res
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


function wrap (prefix, fn, ar) {
  debugger;
  const startCh = channel(prefix + ':start')
  const endCh = channel(prefix + ':end')
  const asyncEndCh = channel(prefix + ':async-end')
  const errorCh = channel(prefix + ':error')

  const wrapped = function (key, value, options, callback) {
    debugger;
    // create asyncResource method
    if (
      !startCh.hasSubscribers
    ) {
      return fn.apply(this, arguments)
    }

    const callbackIndex = findCallbackIndex(arguments)

    if (callbackIndex < 0) return fn.apply(this, arguments)

    // const cb = bind(arguments[callbackIndex])
    const cb = bindAsyncResource.call(ar, arguments[callbackIndex])

    startCh.publish([this])

    arguments[callbackIndex] = bind(function (error, result) {
      if (error) {
        errorCh.publish(error)
      }
      asyncEndCh.publish(result)
      return cb.apply(this, arguments)
    })

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
