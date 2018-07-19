'use strict'

const Tags = require('opentracing').Tags

function createWrapRequest (tracer, config) {
  return function wrapRequest (request) {
    return function requestWithTrace (params, cb) {
      const scope = tracer.scopeManager().active()
      const span = tracer.startSpan('elasticsearch.query', {
        childOf: scope && scope.span(),
        tags: {
          [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_CLIENT,
          [Tags.DB_TYPE]: 'elasticsearch',
          'service.name': config.service || `${tracer._service}-elasticsearch`,
          'resource.name': `${params.method} ${quantizePath(params.path)}`,
          'span.type': 'elasticsearch',
          'elasticsearch.url': params.path,
          'elasticsearch.method': params.method,
          'elasticsearch.params': JSON.stringify(params.query)
        }
      })

      if (JSON.stringify(params.body)) {
        span.setTag('elasticsearch.body', JSON.stringify(params.body))
      }

      if (typeof cb === 'function') {
        return request.call(this, params, wrapCallback(tracer, span, cb))
      } else {
        const result = request.apply(this, arguments)
        const promise = new Promise((resolve, reject) => {
          result
            .then(function () {
              finish(span)
              resolve.apply(this, arguments)
            })
            .catch(function (e) {
              finish(span, e)
              reject.apply(this, arguments)
            })
        })

        promise.abort = result.abort

        return promise
      }
    }
  }
}

function wrapCallback (tracer, span, done) {
  return function (err) {
    finish(span, err)
    done.apply(null, arguments)
  }
}

function finish (span, err) {
  if (err) {
    span.addTags({
      'error.type': err.name,
      'error.msg': err.message,
      'error.stack': err.stack
    })
  }

  span.finish()
}

function quantizePath (path) {
  return path.replace(/[0-9]+/g, '?')
}

module.exports = [
  {
    name: 'elasticsearch',
    file: 'src/lib/transport.js',
    versions: ['15.x'],
    patch (Transport, tracer, config) {
      this.wrap(Transport.prototype, 'request', createWrapRequest(tracer, config))
    },
    unpatch (Transport) {
      this.unwrap(Transport.prototype, 'request')
    }
  }
]
