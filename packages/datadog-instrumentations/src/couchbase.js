'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

function findCallbackIndex (args) {
  for (let i = args.length - 1; i >= 2; i--) {
    if (typeof args[i] === 'function') return i
  }
  return -1
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

      startCh.publish({ bucket: { name: this.name || this._name } })

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
function wrapWithName (name) {
  return function (operation) {
    return function () { // no arguments used by us
      return wrapCBorPromise(operation, name, {
        collection: { name: this._name || '_default' },
        bucket: { name: this._scope._bucket._name }
      })
    }
  }
}

function wrapV3Query (query) {
  return function (q, _options, _callback) {
    const resource = q && (typeof q === 'string' ? q : q.statement) // if it's a n1ql query
    return wrapCBorPromise(query, 'query', { resource })
  }
}

function wrapCBorPromise (fn, name, startData) {
  const startCh = channel(`apm:couchbase:${name}:start`)
  const finishCh = channel(`apm:couchbase:${name}:finish`)
  const errorCh = channel(`apm:couchbase:${name}:error`)

  if (!startCh.hasSubscribers) return fn.apply(this, arguments)

  const asyncResource = new AsyncResource('bound-anonymous-fn')
  const callbackResource = new AsyncResource('bound-anonymous-fn')

  return asyncResource.runInAsyncScope(() => {
    startCh.publish(startData)

    try {
      const cbIndex = findCallbackIndex(arguments)
      if (cbIndex >= 0) {
        // v3 offers callback or promises event handling
        const cb = callbackResource.bind(arguments[cbIndex])
        arguments[cbIndex] = asyncResource.bind(function (error, result) {
          if (error) {
            errorCh.publish(error)
          }
          finishCh.publish({ result })
          return cb.apply(this, arguments)
        })
      }
      const res = fn.apply(this, arguments)

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

function wrapPromiseHelperFn (fn) {
  return function () {
    const cbIndex = findCallbackIndex(arguments)
    arguments[cbIndex] = AsyncResource.bind(arguments[cbIndex])

    return new Promise((resolve, reject) => {
      fn.apply(this, arguments)
        .then(AsyncResource.bind(res => resolve(res)))
        .catch(AsyncResource.bind(err => reject(err)))
    })
  }
}

// semver >=2 <3
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
      startCh.publish({ resource: n1qlQuery, bucket: { name: this.name || this._name } })

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

// semver >=3 <3.2.0

addHook({ name: 'couchbase', file: 'lib/collection.js', versions: ['>=3.0.0 <3.2.0'] }, Collection => {
  shimmer.wrap(Collection.prototype, 'upsert', wrapWithName('upsert'))
  shimmer.wrap(Collection.prototype, 'insert', wrapWithName('insert'))
  shimmer.wrap(Collection.prototype, 'replace', wrapWithName('replace'))
  shimmer.wrap(Collection.prototype, 'append', wrapWithName('append'))
  shimmer.wrap(Collection.prototype, 'prepend', wrapWithName('prepend'))

  return Collection
})

addHook({ name: 'couchbase', file: 'lib/cluster.js', versions: ['>=3.0.0 <3.2.0'] }, Cluster => {
  shimmer.wrap(Cluster.prototype, 'query', wrapV3Query)
  return Cluster
})

addHook({ name: 'couchbase', file: 'lib/promisehelper.js', versions: ['>=3.0.0 <3.2.0'] }, PromiseHelper => {
  shimmer.wrap(PromiseHelper.prototype, 'wrapAsync', wrapPromiseHelperFn)
  shimmer.wrap(PromiseHelper.prototype, 'wrap', wrapPromiseHelperFn)
  shimmer.wrap(PromiseHelper.prototype, 'wrapRowEmitter', wrapPromiseHelperFn)
  shimmer.wrap(PromiseHelper.prototype, 'wrapStreamEmitter', wrapPromiseHelperFn)
  return PromiseHelper
})

// semver >=3.2.0

addHook({ name: 'couchbase', file: 'dist/collection.js', versions: ['>=3.2.0'] }, collection => {
  const Collection = collection.Collection

  shimmer.wrap(Collection.prototype, 'upsert', wrapWithName('upsert'))
  shimmer.wrap(Collection.prototype, 'insert', wrapWithName('insert'))
  shimmer.wrap(Collection.prototype, 'replace', wrapWithName('replace'))
  shimmer.wrap(Collection.prototype, 'append', wrapWithName('append'))
  shimmer.wrap(Collection.prototype, 'prepend', wrapWithName('prepend'))

  return collection
})

addHook({ name: 'couchbase', file: 'dist/cluster.js', versions: ['>=3.2.0'] }, cluster => {
  const Cluster = cluster.Cluster
  shimmer.wrap(Cluster.prototype, 'query', wrapV3Query)
  return cluster
})

addHook({ name: 'couchbase', file: 'dist/utilities.js', versions: ['>=3.2.0'] }, utilities => {
  const PromiseHelper = utilities.PromiseHelper
  shimmer.wrap(PromiseHelper.prototype, 'wrapAsync', wrapPromiseHelperFn)
  shimmer.wrap(PromiseHelper.prototype, 'wrap', wrapPromiseHelperFn)
  return utilities
})
