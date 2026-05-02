'use strict'

const { errorMonitor } = require('events')
const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')

/**
 * @typedef {object} ChannelBag
 * @property {ReturnType<typeof channel>} start
 * @property {ReturnType<typeof channel>} finish
 * @property {ReturnType<typeof channel>} error
 * @property {ReturnType<typeof channel>} callbackStart
 * @property {ReturnType<typeof channel>} callbackFinish
 */

// Cache the per-op channel set keyed by `apm:couchbase:<name>` so each traced
// call skips the template-literal allocation and the `channel(...)` lookup.
/** @type {Map<string, ChannelBag>} */
const channelBags = new Map()

/**
 * @param {string} prefix Full channel prefix, e.g. `apm:couchbase:query`.
 * @returns {ChannelBag}
 */
function getChannelBag (prefix) {
  let bag = channelBags.get(prefix)
  if (bag === undefined) {
    bag = {
      start: channel(`${prefix}:start`),
      finish: channel(`${prefix}:finish`),
      error: channel(`${prefix}:error`),
      callbackStart: channel(`${prefix}:callback:start`),
      callbackFinish: channel(`${prefix}:callback:finish`),
    }
    channelBags.set(prefix, bag)
  }
  return bag
}

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

function wrapCallback (callback, ctx, channelPrefix) {
  const channels = getChannelBag(channelPrefix)

  const wrapped = channels.callbackStart.runStores(ctx, () => {
    return function (...args) {
      return channels.callbackFinish.runStores(ctx, () => {
        return callback.apply(this, args)
      })
    }
  })
  Object.defineProperty(wrapped, '_dd_wrapped', { value: true })
  return wrapped
}

function wrapQuery (query) {
  return function (q, params, callback) {
    const cb = arguments[arguments.length - 1]
    if (typeof cb === 'function') {
      const ctx = {}
      arguments[arguments.length - 1] = wrapCallback(cb, ctx, 'apm:couchbase:query')
    }

    return query.apply(this, arguments)
  }
}

function wrapCallbackFinish (callback, thisArg, _args, channels, ctx) {
  const wrapped = channels.callbackStart.runStores(ctx, () => {
    return function finish (error, result) {
      return channels.callbackFinish.runStores(ctx, () => {
        if (error) {
          ctx.error = error
          channels.error.publish(ctx)
        }
        channels.finish.publish(ctx)
        return callback.apply(thisArg, [error, result])
      })
    }
  })
  Object.defineProperty(wrapped, '_dd_wrapped', { value: true })
  return wrapped
}

function wrap (prefix, fn) {
  const channels = getChannelBag(prefix)

  return function (...args) {
    if (!channels.start.hasSubscribers) {
      return fn.apply(this, args)
    }

    const callbackIndex = findCallbackIndex(args, 1)

    if (callbackIndex < 0) return fn.apply(this, args)

    const ctx = { bucket: { name: this.name || this._name }, seedNodes: this._dd_hosts }
    return channels.start.runStores(ctx, () => {
      const cb = args[callbackIndex]

      args[callbackIndex] = shimmer.wrapFunction(cb, (cb) => {
        return wrapCallbackFinish(cb, this, args, channels, ctx)
      })

      try {
        return fn.apply(this, args)
      } catch (error) {
        ctx.error = error
        void error.stack // trigger getting the stack at the original throwing point
        channels.error.publish(ctx)

        throw error
      }
    })
  }
}

// semver >=2 <3
function wrapMaybeInvoke (_maybeInvoke, channelPrefix) {
  return function (fn, args) {
    if (!Array.isArray(args)) return _maybeInvoke.apply(this, arguments)

    const callbackIndex = findCallbackIndex(args, 0)

    if (callbackIndex === -1) return _maybeInvoke.apply(this, arguments)

    const callback = args[callbackIndex]

    if (typeof callback === 'function' && !callback._dd_wrapped) {
      const ctx = {}
      args[callbackIndex] = wrapCallback(callback, ctx, channelPrefix)
    }

    return _maybeInvoke.apply(this, arguments)
  }
}

// semver >=3

function wrapCBandPromise (fn, name, startData, thisArg, args) {
  const channels = getChannelBag(`apm:couchbase:${name}`)

  if (!channels.start.hasSubscribers) return fn.apply(thisArg, args)

  const ctx = startData
  return channels.start.runStores(ctx, () => {
    try {
      const cbIndex = findCallbackIndex(args, 1)
      if (cbIndex >= 0) {
        // v3 offers callback or promises event handling
        // NOTE: this does not work with v3.2.0-3.2.1 cluster.query, as there is a bug in the couchbase source code
        args[cbIndex] = shimmer.wrapFunction(args[cbIndex], (cb) => {
          return wrapCallbackFinish(cb, thisArg, args, channels, ctx)
        })
      }
      const res = fn.apply(thisArg, args)

      // semver >=3 will always return promise by default
      res.then(
        (result) => {
          ctx.result = result
          channels.finish.publish(ctx)
        },
        (err) => {
          ctx.error = err
          channels.error.publish(ctx)
          channels.finish.publish(ctx)
        }
      )
      return res
    } catch (e) {
      void e.stack
      ctx.error = e
      channels.error.publish(ctx)
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

// semver >=2 <3
addHook({ name: 'couchbase', file: 'lib/bucket.js', versions: ['^2.6.12'] }, Bucket => {
  shimmer.wrap(Bucket.prototype, '_maybeInvoke', maybeInvoke => {
    return wrapMaybeInvoke(maybeInvoke, 'apm:couchbase:bucket:maybeInvoke')
  })

  const queryChannels = getChannelBag('apm:couchbase:query')

  shimmer.wrap(Bucket.prototype, 'query', query => wrapQuery(query))

  shimmer.wrap(Bucket.prototype, '_n1qlReq', _n1qlReq => function (host, q, adhoc, emitter) {
    if (!queryChannels.start.hasSubscribers) {
      return _n1qlReq.apply(this, arguments)
    }

    if (!emitter || !emitter.once) return _n1qlReq.apply(this, arguments)

    const n1qlQuery = getQueryResource(q)

    const ctx = { resource: n1qlQuery, bucket: { name: this.name || this._name }, seedNodes: this._dd_hosts }
    return queryChannels.start.runStores(ctx, () => {
      emitter.once('rows', () => {
        queryChannels.finish.publish(ctx)
      })

      emitter.once(errorMonitor, (error) => {
        if (!error) return
        ctx.error = error
        queryChannels.error.publish(ctx)
        queryChannels.finish.publish(ctx)
      })

      try {
        return _n1qlReq.apply(this, arguments)
      } catch (err) {
        void err.stack // trigger getting the stack at the original throwing point
        ctx.error = err
        queryChannels.error.publish(ctx)

        throw err
      }
    })
  })

  wrapAllNames(['upsert', 'insert', 'replace', 'append', 'prepend'], name => {
    shimmer.wrap(Bucket.prototype, name, fn => wrap(`apm:couchbase:${name}`, fn))
  })
})

addHook({ name: 'couchbase', file: 'lib/cluster.js', versions: ['^2.6.12'] }, Cluster => {
  shimmer.wrap(Cluster.prototype, '_maybeInvoke', maybeInvoke => {
    return wrapMaybeInvoke(maybeInvoke, 'apm:couchbase:cluster:maybeInvoke')
  })

  shimmer.wrap(Cluster.prototype, 'query', query => wrapQuery(query))
  shimmer.wrap(Cluster.prototype, 'openBucket', openBucket => {
    return function (...args) {
      const bucket = openBucket.apply(this, args)
      const hosts = this.dsnObj.hosts
      bucket._dd_hosts = hosts.map(hostAndPort => hostAndPort.join(':')).join(',')
      return bucket
    }
  })
})

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
