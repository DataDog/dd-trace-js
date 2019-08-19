'use strict'

const Tags = require('../../../ext/tags')
const Kinds = require('../../../ext/kinds')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const tx = require('../../dd-trace/src/plugins/util/tx.js')

function startQuerySpan (tracer, config, queryType, query) {
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
  const errorListener = (err) => {
    span.setTag(Tags.ERROR, err)
    span.finish()
  }
  const rowsListener = () => {
    span.finish()
  }

  emitter.once('rows', () => {
    rowsListener()
    emitter.removeListener('error', errorListener)
  })
  emitter.once('error', (err) => {
    errorListener(err)
    emitter.removeListener('rows', rowsListener)
  })
}

function createWrapMaybeInvoke (tracer) {
  return function wrapMaybeInvoke (_maybeInvoke) {
    return function maybeInvokeWithTrace (fn, args) {
      const scope = tracer.scope()

      fn = scope.bind(fn)
      return _maybeInvoke.call(this, fn, args)
    }
  }
}

function createWrapN1qlQuery (tracer, config) {
  return function wrapN1qlQuery (_n1ql) {
    return function n1qlQueryWithTrace (query) {
      const callback = arguments[_n1ql.length - 1]
      const scope = tracer.scope()
      const n1qlQuery = query.options.statement
      const span = startQuerySpan(tracer, config, 'n1ql', n1qlQuery)

      if (callback) {
        arguments[_n1ql.length - 1] = tx.wrap(span, callback)
      }

      const req = scope.bind(_n1ql, span).apply(this, arguments)

      onRequestFinish(req, span)

      return scope.bind(req)
    }
  }
}

function createWrapN1qlRequest (tracer) {
  return function wrapN1qlRequest (_n1qlReq) {
    return function n1qlRequestWithTrace (host) {
      const span = tracer.scope().active()

      addBucketTag(span, this)
      addHostTag(span, host)

      return _n1qlReq.apply(this, arguments)
    }
  }
}

function createWrapOpenBucket (tracer) {
  return function wrapOpenBucket (openBucket) {
    return function openBucketWithTrace () {
      const bucket = openBucket.apply(this, arguments)
      return tracer.scope().bind(bucket)
    }
  }
}

function addBucketTag (span, bucket) {
  span.setTag('couchbase.bucket.name', bucket.name || bucket._name)
}

function addHostTag (span, host) {
  if (!host) return

  const conn = host.split(':')
  span.setTag('out.host', conn[0])
  span.setTag('out.port', conn[1])
}

function wrapQueries (Class, tracer, config) {
  this.wrap(Class.prototype, '_n1ql', createWrapN1qlQuery(tracer, config))
}

function unwrapQueries (Class) {
  this.unwrap(Class.prototype, '_n1ql')
}

function wrapRequests (Class, tracer) {
  this.wrap(Class.prototype, '_n1qlReq', createWrapN1qlRequest(tracer))
}

function unwrapRequests (Class, tracer) {
  this.unwrap(Class.prototype, '_n1qlReq')
}

module.exports = [
  {
    name: 'couchbase',
    versions: ['>=2.4.0'],
    file: 'lib/bucket.js',
    patch (Bucket, tracer, config) {
      this.wrap(Bucket.prototype, '_maybeInvoke', createWrapMaybeInvoke(tracer))

      wrapQueries.call(this, Bucket, tracer, config)
      wrapRequests.call(this, Bucket, tracer)
    },
    unpatch (Bucket) {
      this.unwrap(Bucket.prototype, '_maybeInvoke')

      unwrapQueries.call(this, Bucket)
      unwrapRequests.call(this, Bucket)
    }
  },
  {
    name: 'couchbase',
    versions: ['>=2.6.0'],
    file: 'lib/cluster.js',
    patch (Cluster, tracer, config) {
      this.wrap(Cluster.prototype, 'openBucket', createWrapOpenBucket(tracer))
      this.wrap(Cluster.prototype, '_maybeInvoke', createWrapMaybeInvoke(tracer))

      wrapQueries.call(this, Cluster, tracer, config)
    },
    unpatch (Cluster) {
      this.unwrap(Cluster.prototype, 'openBucket')
      this.unwrap(Cluster.prototype, '_maybeInvoke')

      unwrapQueries.call(this, Cluster)
    }
  },
  {
    name: 'couchbase',
    versions: ['2.4.0 - 2.5.1'],
    file: 'lib/cluster.js',
    patch (Cluster, tracer, config) {
      this.wrap(Cluster.prototype, 'openBucket', createWrapOpenBucket(tracer, config))
      this.wrap(Cluster.prototype, '_maybeInvoke', createWrapMaybeInvoke(tracer, config))

      wrapQueries.call(this, Cluster, tracer, config)
    },
    unpatch (Cluster) {
      this.unwrap(Cluster.prototype, 'openBucket')
      this.unwrap(Cluster.prototype, '_maybeInvoke')

      unwrapQueries.call(this, Cluster)
    }
  }
]
