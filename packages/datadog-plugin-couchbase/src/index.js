'use strict'

const Tags = require('../../../ext/tags')
const Kinds = require('../../../ext/kinds')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

function startSpan (tracer, config, operation, resource) {
  const childOf = tracer.scope().active()
  const span = tracer.startSpan(`couchbase.${operation}`, {
    childOf,
    tags: {
      'db.type': 'couchbase',
      'component': 'couchbase',
      'service.name': config.service || `${tracer._service}-couchbase`,
      'resource.name': resource,
      [Tags.SPAN_KIND]: Kinds.CLIENT
    }
  })

  analyticsSampler.sample(span, config.measured)

  return span
}

function onRequestFinish (emitter, span) {
  emitter.once('rows', () => {
    span.finish()
  })
  emitter.once('error', (err) => {
    span.setTag(Tags.ERROR, err)
    span.finish()
  })
}

function createWrapMaybeInvoke (tracer) {
  return function wrapMaybeInvoke (_maybeInvoke) {
    return function maybeInvokeWithTrace (fn, args) {
      if (!Array.isArray(args)) return _maybeInvoke.apply(this, arguments)

      const scope = tracer.scope()
      const callbackIndex = args.length - 1
      const callback = args[callbackIndex]

      if (callback instanceof Function) {
        args[callbackIndex] = scope.bind(callback)
      }

      return scope.bind(_maybeInvoke).apply(this, arguments)
    }
  }
}

function createWrapQuery (tracer) {
  return function wrapQuery (query) {
    return function queryWithTrace (q, params, callback) {
      const scope = tracer.scope()

      callback = arguments[arguments.length - 1]

      if (typeof callback === 'function') {
        arguments[arguments.length - 1] = scope.bind(callback)
      }

      return scope.bind(query.apply(this, arguments))
    }
  }
}

function createWrapN1qlReq (tracer, config) {
  return function wrapN1qlReq (_n1qlReq) {
    return function n1qlReqWithTrace (host, q, adhoc, emitter) {
      if (!emitter || !emitter.once) return _n1qlReq.apply(this, arguments)

      const scope = tracer.scope()
      const n1qlQuery = q && q.statement
      const span = startSpan(tracer, config, 'query', n1qlQuery)

      span.setTag('span.type', 'sql')

      addBucketTag(span, this)
      onRequestFinish(emitter, span)

      return scope.bind(_n1qlReq, span).apply(this, arguments)
    }
  }
}

function createWrapStore (tracer, config, operation) {
  return function wrapStore (store) {
    return function storeWithTrace (key, value, options, callback) {
      const callbackIndex = findCallbackIndex(arguments)

      if (callbackIndex < 0) return store.apply(this, arguments)

      const scope = tracer.scope()
      const span = startSpan(tracer, config, operation)

      addBucketTag(span, this)

      arguments[callbackIndex] = wrapCallback(span, arguments[callbackIndex])

      return scope.bind(store, span).apply(this, arguments)
    }
  }
}

function addBucketTag (span, bucket) {
  span.setTag('couchbase.bucket.name', bucket.name || bucket._name)
}

function findCallbackIndex (args) {
  for (let i = args.length - 1; i >= 2; i--) {
    if (typeof args[i] === 'function') return i
  }

  return -1
}

function wrapCallback (span, callback) {
  return function (err, result) {
    span.setTag('error', err)
    span.finish()

    return callback.apply(this, arguments)
  }
}

module.exports = [
  {
    name: 'couchbase',
    versions: ['^2.6.5'],
    file: 'lib/bucket.js',
    patch (Bucket, tracer, config) {
      tracer.scope().bind(Bucket.prototype)

      this.wrap(Bucket.prototype, '_maybeInvoke', createWrapMaybeInvoke(tracer, config))
      this.wrap(Bucket.prototype, 'query', createWrapQuery(tracer))
      this.wrap(Bucket.prototype, '_n1qlReq', createWrapN1qlReq(tracer, config))
      this.wrap(Bucket.prototype, 'upsert', createWrapStore(tracer, config, 'upsert'))
      this.wrap(Bucket.prototype, 'insert', createWrapStore(tracer, config, 'insert'))
      this.wrap(Bucket.prototype, 'replace', createWrapStore(tracer, config, 'replace'))
      this.wrap(Bucket.prototype, 'append', createWrapStore(tracer, config, 'append'))
      this.wrap(Bucket.prototype, 'prepend', createWrapStore(tracer, config, 'prepend'))
    },
    unpatch (Bucket, tracer) {
      tracer.scope().unbind(Bucket.prototype)

      this.unwrap(Bucket.prototype, '_maybeInvoke')
      this.unwrap(Bucket.prototype, 'query')
      this.unwrap(Bucket.prototype, '_n1qlReq')
      this.unwrap(Bucket.prototype, 'upsert')
      this.unwrap(Bucket.prototype, 'insert')
      this.unwrap(Bucket.prototype, 'replace')
      this.unwrap(Bucket.prototype, 'append')
      this.unwrap(Bucket.prototype, 'prepend')
    }
  },
  {
    name: 'couchbase',
    versions: ['^2.6.5'],
    file: 'lib/cluster.js',
    patch (Cluster, tracer, config) {
      this.wrap(Cluster.prototype, '_maybeInvoke', createWrapMaybeInvoke(tracer, config))
      this.wrap(Cluster.prototype, 'query', createWrapQuery(tracer))
    },
    unpatch (Cluster) {
      this.unwrap(Cluster.prototype, '_maybeInvoke')
      this.unwrap(Cluster.prototype, 'query')
    }
  }
]
