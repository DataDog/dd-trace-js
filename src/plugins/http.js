'use strict'

const url = require('url')
const opentracing = require('opentracing')

const Tags = opentracing.Tags
const FORMAT_HTTP_HEADERS = opentracing.FORMAT_HTTP_HEADERS

function patch (http, tracer, config) {
  this.wrap(http, 'request', request => makeRequestTrace(request))
  this.wrap(http, 'get', get => makeRequestTrace(get))

  function makeRequestTrace (request) {
    return function requestTrace (options, callback) {
      const uri = extractUrl(options)
      const method = (options.method || 'GET').toUpperCase()

      if (uri === `${tracer._url.href}/v0.3/traces`) {
        return request.apply(this, [options, callback])
      }

      let span
      let isFinish = false

      tracer.trace('http.request', {
        tags: {
          [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_CLIENT,
          [Tags.HTTP_URL]: uri,
          [Tags.HTTP_METHOD]: method
        }
      }, child => {
        span = child

        options = typeof options === 'string' ? url.parse(uri) : Object.assign({}, options)
        options.headers = options.headers || {}

        span.addTags({
          'service.name': config.service || 'http-client',
          'span.type': 'web',
          'resource.name': method
        })

        tracer.inject(span, FORMAT_HTTP_HEADERS, options.headers)
      })

      const req = request.call(this, options, res => {
        span.setTag(Tags.HTTP_STATUS_CODE, res.statusCode)
        res.on('end', finish)
        callback && callback(res)
      })

      req.on('socket', socket => {
        socket.on('close', finish)
      })

      req.on('error', err => {
        span.addTags({
          'error.type': err.name,
          'error.msg': err.message,
          'error.stack': err.stack
        })

        span.finish()
      })

      function finish () {
        if (!isFinish) {
          isFinish = true
          span.finish()
        }
      }

      return req
    }
  }

  function extractUrl (options) {
    const uri = options
    const agent = options.agent || http.globalAgent

    return typeof uri === 'string' ? uri : url.format({
      protocol: options.protocol || agent.protocol,
      hostname: options.hostname || options.host || 'localhost',
      port: options.port,
      pathname: options.path || options.pathname || '/'
    })
  }
}

function unpatch (http) {
  this.unwrap(http, 'request')
  this.unwrap(http, 'get')
}

module.exports = {
  name: 'http',
  patch,
  unpatch
}
