'use strict'

const Tags = require('opentracing').Tags
const shimmer = require('shimmer')

function createWrapRequest (tracer, config) {
  return function wrapRequest (request) {
    return function requestWithTrace (params, cb) {
      let returnValue

      tracer._context.run(() => {
        let defer

        if (typeof cb === 'function') {
          cb = tracer.bind(cb)
        } else {
          defer = this.defer()

          cb = tracer.bind((err, parsedBody, status) => {
            if (err) {
              err.body = parsedBody
              err.status = status
              defer.reject(err)
            } else {
              defer.resolve(parsedBody)
            }
          })
        }

        tracer.trace('elasticsearch.query', {
          tags: {
            [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_CLIENT,
            [Tags.DB_TYPE]: 'elasticsearch'
          }
        }, span => {
          span.addTags({
            'service.name': config.service || 'elasticsearch',
            'resource.name': `${params.method} ${quantizePath(params.path)}`,
            'span.type': 'db',
            'elasticsearch.url': params.path,
            'elasticsearch.method': params.method,
            'elasticsearch.params': JSON.stringify(params.query)
          })

          if (JSON.stringify(params.body)) {
            span.setTag('elasticsearch.body', JSON.stringify(params.body))
          }

          if (!defer) {
            returnValue = request.call(this, params, wrapCallback(tracer, span, cb))
          } else {
            const ret = request.call(this, params, wrapCallback(tracer, span, cb))

            returnValue = defer.promise
            returnValue.abort = ret.abort
          }
        })
      })

      return returnValue
    }
  }
}

function createWrapSelect (tracer, config) {
  return function wrapSelect (select) {
    return function selectWithTrace (cb) {
      const span = tracer.currentSpan()

      return select.call(this, function (_, conn) {
        if (conn && conn.host) {
          span.addTags({
            'out.host': conn.host.host,
            'out.port': conn.host.port
          })
        }

        return cb.apply(null, arguments)
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
    file: 'src/lib/connection_pool.js',
    versions: ['15.x'],
    patch (ConnectionPool, tracer, config) {
      shimmer.wrap(ConnectionPool.prototype, 'select', createWrapSelect(tracer, config))
    },
    unpatch (ConnectionPool) {
      shimmer.unwrap(ConnectionPool.prototype, 'select')
    }
  },
  {
    name: 'elasticsearch',
    file: 'src/lib/transport.js',
    versions: ['15.x'],
    patch (Transport, tracer, config) {
      shimmer.wrap(Transport.prototype, 'request', createWrapRequest(tracer, config))
    },
    unpatch (Transport) {
      shimmer.unwrap(Transport.prototype, 'request')
    }
  }
]
