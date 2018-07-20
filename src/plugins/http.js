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

      let isFinish = false

      options = typeof options === 'string' ? url.parse(uri) : Object.assign({}, options)
      options.headers = options.headers || {}

      const parentScope = tracer.scopeManager().active()
      const parent = parentScope && parentScope.span()
      const span = tracer.startSpan('http.request', {
        childOf: parent,
        tags: {
          [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_CLIENT,
          'service.name': getServiceName(tracer, config, options),
          'resource.name': method,
          'span.type': 'web',
          'http.method': method,
          'http.url': uri
        }
      })

      tracer.inject(span, FORMAT_HTTP_HEADERS, options.headers)

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

function getHost (options) {
  if (typeof options === 'string') {
    return url.parse(options).host
  }

  const hostname = options.hostname || options.host || 'localhost'
  const port = options.port

  return [hostname, port].filter(val => val).join(':')
}

function getServiceName (tracer, config, options) {
  if (config.splitByDomain) {
    return getHost(options)
  } else if (config.service) {
    return config.service
  }

  return `${tracer._service}-http-client`
}

function unpatch (http) {
  this.unwrap(http, 'request')
  this.unwrap(http, 'get')
}

module.exports = [
  {
    name: 'http',
    patch,
    unpatch
  },
  {
    name: 'https',
    patch,
    unpatch
  }
]
