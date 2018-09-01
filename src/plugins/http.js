'use strict'

const url = require('url')
const opentracing = require('opentracing')

const Tags = opentracing.Tags
const FORMAT_HTTP_HEADERS = opentracing.FORMAT_HTTP_HEADERS

function patch (http, tracer, config) {
  this.wrap(http, 'request', makeRequestTrace)
  this.wrap(http, 'get', makeGetTrace)

  function makeRequestTrace (request) {
    return function requestTrace (options, callback) {
      const req = request.call(this, options, callback)

      // The `https.request` function before Node v9 internally invokes `http.request`. When both modules have been
      // loaded by the user (indirectly) and both modules have been patched by us, that would lead to us double-counting
      // the request.
      if (isTraced(req, options)) {
        return req
      }
      // Here we mark the `req` object, as opposed to also marking the `options` object like we do in `get`. The problem
      // is that if we’d mark `options` here, it would get lost while upstream `request` derives a clone from it and
      // thus would never get to the recursive invocation of `request`.
      markAsTraced(req)

      const span = createSpan(options)
      if (span) {
        const headers = createHeaders(span, options)
        for (const header in headers) {
          req.setHeader(header, headers[header])
        }
        registerEventHandlers(req, span)
      }
      return req
    }
  }

  // Regardless of what Node version we’re running on, `https.get` does not invoke our patched `https.request`, thus we
  // need to patch it as well.
  function makeGetTrace (get) {
    return function getTrace (options, callback) {
      options = typeof options === 'string' ? url.parse(options) : Object.assign({}, options)
      options.headers = options.headers || {}

      // Prevent from double-counting in `request`.
      markAsTraced(options)

      const span = createSpan(options)
      if (!span) {
        return get.call(this, options, callback)
      }

      Object.assign(options.headers, createHeaders(span, options))

      const req = get.call(this, options, callback)
      registerEventHandlers(req, span)
      return req
    }
  }

  function registerEventHandlers (req, span) {
    req.on('socket', () => {
      // empty the data stream when no other listener exists to consume it
      if (req.listenerCount('response') === 1) {
        req.on('response', res => res.resume())
      }
    })

    req.on('response', res => {
      span.setTag(Tags.HTTP_STATUS_CODE, res.statusCode)
      res.on('end', () => span.finish())
    })

    req.on('error', err => {
      span.addTags({
        'error.type': err.name,
        'error.msg': err.message,
        'error.stack': err.stack
      })

      span.finish()
    })
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

  function createSpan (options) {
    const uri = extractUrl(options)
    if (uri === `${tracer._url.href}/v0.3/traces`) {
      return null
    }
    const method = (options.method || 'GET').toUpperCase()
    const parentScope = tracer.scopeManager().active()
    const parent = parentScope && parentScope.span()
    const span = tracer.startSpan('http.request', {
      childOf: parent,
      tags: {
        [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_CLIENT,
        'service.name': getServiceName(options),
        'resource.name': method,
        'span.type': 'web',
        'http.method': method,
        'http.url': uri
      }
    })
    return span
  }

  function createHeaders (span, options) {
    if (!hasAmazonSignature(options)) {
      const headers = {}
      tracer.inject(span, FORMAT_HTTP_HEADERS, headers)
      return headers
    }
    return null
  }

  function getServiceName (options) {
    if (config.splitByDomain) {
      return getHost(options)
    } else if (config.service) {
      return config.service
    }

    return `${tracer._service}-http-client`
  }
}

function markAsTraced (object) {
  Object.defineProperty(object, '_datadog_traced', { value: true })
}

function isTraced (req, options) {
  return req._datadog_traced || options._datadog_traced
}

function getHost (options) {
  if (typeof options === 'string') {
    return url.parse(options).host
  }

  const hostname = options.hostname || options.host || 'localhost'
  const port = options.port

  return [hostname, port].filter(val => val).join(':')
}

function hasAmazonSignature (options) {
  if (!options) {
    return false
  }

  if (options.headers) {
    const headers = Object.keys(options.headers)
      .reduce((prev, next) => Object.assign(prev, {
        [next.toLowerCase()]: options.headers[next]
      }), {})

    if (headers['x-amz-signature']) {
      return true
    }

    if ([].concat(headers['authorization']).some(startsWith('AWS4-HMAC-SHA256'))) {
      return true
    }
  }

  return options.path && options.path.toLowerCase().indexOf('x-amz-signature=') !== -1
}

function startsWith (searchString) {
  return value => String(value).startsWith(searchString)
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
