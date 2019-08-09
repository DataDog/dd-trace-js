'use strict'

const Tags = require('../../../ext/tags')
const Kinds = require('../../../ext/kinds')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const tx = require('../../dd-trace/src/plugins/util/tx.js')

function startQuerySpan (tracer, config, queryType, query) {
  const childOf = tracer.scope().active()
  const span = tracer.startSpan('couchbase.call', {
    childOf,
    tags: {
      'db.type': 'couchbase',
      'span.type': 'sql',
      'component': 'couchbase',
      'service.name': config.service || `${tracer._service}-couchbase`,
      'resource.name': query,
      'query.type': queryType,
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

      addBucketTag(this, span)
      span.setTag('cluster.host', host)

      return _n1qlReq.apply(this, arguments)
    }
  }
}

function createWrapViewQuery (tracer, config) {
  return function wrapViewQuery (_view) {
    return function viewQueryWithTrace () {
      const viewName = arguments[2]
      const callback = arguments[_view.length - 1]
      const scope = tracer.scope()
      const span = startQuerySpan(tracer, config, 'view', viewName)

      if (callback) {
        arguments[_view.length - 1] = tx.wrap(span, callback)
      }

      const req = scope.bind(_view, span).apply(this, arguments)

      onRequestFinish(req, span)

      return scope.bind(req)
    }
  }
}

function createWrapViewRequest (tracer) {
  return function wrapViewRequest (_viewReq) {
    return function viewRequestWithTrace () {
      const span = tracer.scope().active()
      const ddoc = arguments[1]

      addBucketTag(this, span)
      span.setTag('ddoc', ddoc)

      return _viewReq.apply(this, arguments)
    }
  }
}

function createWrapFtsQuery (tracer, config) {
  return function wrapFtsQuery (_fts) {
    return function ftsQueryWithTrace (query) {
      const callback = arguments[_fts.length - 1]
      const scope = tracer.scope()
      const index = query.data.indexName
      const span = startQuerySpan(tracer, config, 'search', index)

      if (callback) {
        arguments[_fts.length - 1] = tx.wrap(span, callback)
      }

      const req = scope.bind(_fts, span).apply(this, arguments)

      onRequestFinish(req, span)

      return scope.bind(req)
    }
  }
}

function createWrapFtsRequest (tracer) {
  return function wrapFtsRequest (_ftsReq) {
    return function ftsRequestWithTrace () {
      const span = tracer.scope().active()

      addBucketTag(this, span)

      return _ftsReq.apply(this, arguments)
    }
  }
}

function createWrapCbasQuery (tracer, config) {
  return function wrapCbasQuery (_cbas) {
    return function cbasQueryWithTrace (query) {
      const callback = arguments[_cbas.length - 1]
      const scope = tracer.scope()
      const cbasQuery = query.options.statement
      const span = startQuerySpan(tracer, config, 'cbas', cbasQuery)

      if (callback) {
        arguments[_cbas.length] = tx.wrap(span, callback)
      }

      const req = scope.bind(_cbas, span).apply(this, arguments)

      onRequestFinish(req, span)

      return scope.bind(req)
    }
  }
}

function createWrapCbasRequest (tracer) {
  return function wrapCbasRequest (_cbasReq) {
    return function cbasRequestWithTrace (host) {
      const span = tracer.scope().active()

      addBucketTag(this, span)
      span.setTag('cbas.host', host)

      return _cbasReq.apply(this, arguments)
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

function addBucketTag (bucket, span) {
  span.setTag('bucket.name', bucket.name || bucket._name)
}

function wrapQueries (Class, tracer, config) {
  this.wrap(Class.prototype, '_n1ql', createWrapN1qlQuery(tracer, config))
  this.wrap(Class.prototype, '_fts', createWrapFtsQuery(tracer, config))

  if (Class.prototype._view) {
    this.wrap(Class.prototype, '_view', createWrapViewQuery(tracer, config))
  }

  if (Class.prototype._cbas) {
    this.wrap(Class.prototype, '_cbas', createWrapCbasQuery(tracer, config))
  }
}

function unwrapQueries (Class) {
  this.unwrap(Class.prototype, '_n1ql')
  this.unwrap(Class.prototype, '_fts')

  if (Class.prototype._view) {
    this.unwrap(Class.prototype, '_view')
  }

  if (Class.prototype._cbas) {
    this.unwrap(Class.prototype, '_cbas')
  }
}

function wrapRequests (Class, tracer) {
  this.wrap(Class.prototype, '_n1qlReq', createWrapN1qlRequest(tracer))
  this.wrap(Class.prototype, '_ftsReq', createWrapFtsRequest(tracer))

  if (Class.prototype._viewReq) {
    this.wrap(Class.prototype, '_viewReq', createWrapViewRequest(tracer))
  }

  if (Class.prototype._cbasReq) {
    this.wrap(Class.prototype, '_cbasReq', createWrapCbasRequest(tracer))
  }
}

function unwrapRequests (Class, tracer) {
  this.unwrap(Class.prototype, '_n1qlReq')
  this.unwrap(Class.prototype, '_ftsReq')

  if (Class.prototype._viewReq) {
    this.unwrap(Class.prototype, '_viewReq')
  }

  if (Class.prototype._cbasReq) {
    this.unwrap(Class.prototype, '_cbasReq')
  }
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
      this.wrap(Cluster.prototype, '_cbasReq', createWrapCbasRequest(tracer))
    },
    unpatch (Cluster) {
      this.unwrap(Cluster.prototype, 'openBucket')
      this.unwrap(Cluster.prototype, '_maybeInvoke')

      unwrapQueries.call(this, Cluster)
      this.unwrap(Cluster.prototype, '_cbasReq')
    }
  }
]
