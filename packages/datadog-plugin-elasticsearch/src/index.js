'use strict'

const Tags = require('opentracing').Tags
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

function createWrapRequest (tracer, config) {
  return function wrapRequest (request) {
    return function requestWithTrace (params, options, cb) {
      const childOf = tracer.scope().active()
      const span = tracer.startSpan('elasticsearch.query', {
        childOf,
        tags: {
          [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_CLIENT,
          [Tags.DB_TYPE]: 'elasticsearch',
          'service.name': config.service || `${tracer._service}-elasticsearch`,
          'resource.name': `${params.method} ${quantizePath(params.path)}`,
          'span.type': 'elasticsearch',
          'elasticsearch.url': params.path,
          'elasticsearch.method': params.method,
          'elasticsearch.params': JSON.stringify(params.querystring || params.query)
        }
      })

      if (params.body) {
        span.setTag('elasticsearch.body', JSON.stringify(params.body))
      }

      analyticsSampler.sample(span, config.analytics)

      cb = request.length === 2 || typeof options === 'function'
        ? tracer.scope().bind(options, childOf)
        : tracer.scope().bind(cb, childOf)

      return tracer.scope().activate(span, () => {
        if (typeof cb === 'function') {
          if (request.length === 2) {
            return request.call(this, params, wrapCallback(tracer, span, cb))
          } else {
            return request.call(this, params, options, wrapCallback(tracer, span, cb))
          }
        } else {
          const promise = request.apply(this, arguments)

          promise.then(() => finish(span), e => finish(span, e))

          return promise
        }
      })
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
    versions: ['>=10'],
    patch (Transport, tracer, config) {
      this.wrap(Transport.prototype, 'request', createWrapRequest(tracer, config))
    },
    unpatch (Transport) {
      this.unwrap(Transport.prototype, 'request')
    }
  },
  {
    name: '@elastic/elasticsearch',
    file: 'lib/Transport.js',
    versions: ['>=5.6.16'], // initial version of this module
    patch (Transport, tracer, config) {
      this.wrap(Transport.prototype, 'request', createWrapRequest(tracer, config))
    },
    unpatch (Transport) {
      this.unwrap(Transport.prototype, 'request')
    }
  }
]
