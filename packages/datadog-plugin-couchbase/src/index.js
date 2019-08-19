'use strict'

const URL = require('url')
const Tags = require('../../../ext/tags')
const Kinds = require('../../../ext/kinds')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

const bucketOperations = ['get', 'getMulti', 'getAndTouch', 'getAndLock', 'getReplica', 'touch',
  'unlock', 'remove', 'upsert', 'insert', 'replace', 'append', 'prepend', 'counter', 'mapGet',
  'mapRemove', 'mapSize', 'mapAdd', 'listGet', 'listAppend', 'listPrepend', 'listRemove', 'listSet',
  'listSize', 'setAdd', 'setExists', 'setSize', 'setRemove', 'queuePush', 'queuePop', 'queueSize']

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

function createWrapQuery (tracer) {
  return function wrapQuery (query) {
    return function queryWithTrace (q, params, callback) {
      const scope = tracer.scope()

      if (params instanceof Function) {
        params = scope.bind(params)
      } else {
        callback = scope.bind(callback)
      }

      return scope.bind(query.call(this, q, params, callback))
    }
  }
}

function createWrapN1qlRequest (tracer, config) {
  return function wrapN1qlRequest (_n1qlReq) {
    return function n1qlRequestWithTrace (host, q, adhoc, emitter) {
      const scope = tracer.scope()
      const n1qlQuery = q.statement
      const span = startQuerySpan(tracer, config, 'n1ql', n1qlQuery)

      addBucketTag(span, this)
      addHostTag(span, host)
      onRequestFinish(emitter, span)

      return scope.bind(_n1qlReq, span).apply(this, arguments)
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

function createWrapBucketOperation (tracer) {
  return function wrapBucketOperation (operation) {
    return function operationWithTrace () {
      const scope = tracer.scope()
      const callbackIndex = operation.length - 1
      const callback = arguments[callbackIndex]
      const optionsIndex = callbackIndex - 1
      const options = arguments[optionsIndex]

      if (options instanceof Function) {
        arguments[optionsIndex] = scope.bind(options)
      } else if (callback) {
        arguments[callbackIndex] = scope.bind(callback)
      }

      return operation.apply(this, arguments)
    }
  }
}

function addBucketTag (span, bucket) {
  span.setTag('couchbase.bucket.name', bucket.name || bucket._name)
}

function addHostTag (span, host) {
  if (!host) return

  const url = new URL(host)
  span.setTag('out.host', url.hostname)
  span.setTag('out.port', url.port)
}

function wrapRequests (Class, tracer, config) {
  this.wrap(Class.prototype, '_n1qlReq', createWrapN1qlRequest(tracer, config))
}

function unwrapRequests (Class) {
  this.unwrap(Class.prototype, '_n1qlReq')
}

function wrapCouchbase (Class, tracer, config) {
  if (Class.prototype.openBucket) {
    this.wrap(Class.prototype, 'openBucket', createWrapOpenBucket(tracer, config))
  }
  this.wrap(Class.prototype, '_maybeInvoke', createWrapMaybeInvoke(tracer, config))
  this.wrap(Class.prototype, 'query', createWrapQuery(tracer))
}

function unwrapCouchbase (Class) {
  this.unwrap(Class.prototype, 'openBucket')
  this.unwrap(Class.prototype, '_maybeInvoke')
  this.unwrap(Class.prototype, 'query')
}

function wrapBucketOperations (Bucket, tracer) {
  for (let i = 0; i < bucketOperations.length; ++i) {
    const operation = bucketOperations[i]

    if (Bucket.prototype.hasOwnProperty(operation)) {
      this.wrap(Bucket.prototype, operation, createWrapBucketOperation(tracer))
    }
  }
}

function unwrapBucketOperations (Bucket) {
  for (let i = 0; i < bucketOperations.length; ++i) {
    const operation = bucketOperations[i]

    this.unwrap(Bucket.prototype, operation)
  }
}

module.exports = [
  {
    name: 'couchbase',
    versions: ['>=2.4.0'],
    file: 'lib/bucket.js',
    patch (Bucket, tracer, config) {
      wrapCouchbase.call(this, Bucket, tracer, config)
      wrapRequests.call(this, Bucket, tracer, config)
      wrapBucketOperations.call(this, Bucket, tracer, config)
    },
    unpatch (Bucket) {
      unwrapCouchbase.call(this, Bucket)
      unwrapRequests.call(this, Bucket)
      unwrapBucketOperations.call(this, Bucket)
    }
  },
  {
    name: 'couchbase',
    versions: ['>=2.6.0'],
    file: 'lib/cluster.js',
    patch: wrapCouchbase,
    unpatch: unwrapCouchbase
  },
  {
    name: 'couchbase',
    versions: ['2.4.0 - 2.5.1'],
    file: 'lib/cluster.js',
    patch: wrapCouchbase,
    unpatch: unwrapCouchbase
  }
]
