'use strict'

const Tags = require('../../../ext/tags')
const Kinds = require('../../../ext/kinds')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

function startQuerySpan (tracer, config, query) {
  const childOf = tracer.scope().active()
  const span = tracer.startSpan('couchbase.query', {
    childOf,
    tags: {
      'db.type': 'couchbase',
      'span.type': 'sql',
      'component': 'couchbase',
      'service.name': config.service || `${tracer._service}-couchbase`,
      'resource.name': query,
      [Tags.SPAN_KIND]: Kinds.CLIENT
    }
  })

  analyticsSampler.sample(span, config.analytics)

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
      const span = startQuerySpan(tracer, config, n1qlQuery)

      addBucketTag(span, this)
      onRequestFinish(emitter, span)

      return scope.bind(_n1qlReq, span).apply(this, arguments)
    }
  }
}

function addBucketTag (span, bucket) {
  span.setTag('couchbase.bucket.name', bucket.name || bucket._name)
}

function wrapRequests (Class, tracer, config) {
  this.wrap(Class.prototype, '_n1qlReq', createWrapN1qlReq(tracer, config))
}

function unwrapRequests (Class) {
  this.unwrap(Class.prototype, '_n1qlReq')
}

function wrapCouchbase (Class, tracer, config) {
  this.wrap(Class.prototype, '_maybeInvoke', createWrapMaybeInvoke(tracer, config))
  this.wrap(Class.prototype, 'query', createWrapQuery(tracer))
}

function unwrapCouchbase (Class) {
  this.unwrap(Class.prototype, '_maybeInvoke')
  this.unwrap(Class.prototype, 'query')
}

module.exports = [
  {
    name: 'couchbase',
    versions: ['^2.4.2'],
    file: 'lib/bucket.js',
    patch (Bucket, tracer, config) {
      tracer.scope().bind(Bucket.prototype)

      wrapCouchbase.call(this, Bucket, tracer, config)
      wrapRequests.call(this, Bucket, tracer, config)
    },
    unpatch (Bucket, tracer) {
      tracer.scope().unbind(Bucket.prototype)

      unwrapCouchbase.call(this, Bucket)
      unwrapRequests.call(this, Bucket)
    }
  },
  {
    name: 'couchbase',
    versions: ['^2.4.2'],
    file: 'lib/cluster.js',
    patch: wrapCouchbase,
    unpatch: unwrapCouchbase
  }
]
