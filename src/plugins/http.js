'use strict'

const url = require('url')
const opentracing = require('opentracing')
const semver = require('semver')

const Tags = opentracing.Tags
const FORMAT_HTTP_HEADERS = opentracing.FORMAT_HTTP_HEADERS

function patch (http, methodName, tracer, config) {
  this.wrap(http, methodName, fn => makeRequestTrace(fn))

  function makeRequestTrace (request) {
    return function requestTrace () {
      const args = normalizeArgs.apply(null, arguments)
      const uri = args.uri
      const options = args.options
      const callback = args.callback

      if (uri === `${tracer._url.href}/v0.4/traces`) {
        return request.call(this, options, callback)
      }

      const method = (options.method || 'GET').toUpperCase()

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

      if (!hasAmazonSignature(options)) {
        tracer.inject(span, FORMAT_HTTP_HEADERS, options.headers)
      }

      const req = request.call(this, options, callback)

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

  function normalizeArgs (inputURL, inputOptions, callback) {
    let options = typeof inputURL === 'string' ? url.parse(inputURL) : Object.assign({}, inputURL)
    options.headers = options.headers || {}
    if (typeof inputOptions === 'function') {
      callback = inputOptions
    } else if (typeof inputOptions === 'object') {
      options = Object.assign(options, inputOptions)
    }
    const uri = extractUrl(options)
    return { uri, options, callback }
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
    patch: function (http, tracer, config) {
      patch.call(this, http, 'request', tracer, config)
      if (semver.satisfies(process.version, '>=8')) {
        /**
         * In newer Node versions references internal to modules, such as `http(s).get` calling `http(s).request`, do
         * not use externally patched versions, which is why we need to also patch `get` here separately.
         */
        patch.call(this, http, 'get', tracer, config)
      }
    },
    unpatch
  },
  {
    name: 'https',
    patch: function (http, tracer, config) {
      if (semver.satisfies(process.version, '>=9')) {
        patch.call(this, http, 'request', tracer, config)
        patch.call(this, http, 'get', tracer, config)
      } else {
        /**
         * Below Node v9 the `https` module invokes `http.request`, which would end up counting requests twice.
         * So rather then patch the `https` module, we ensure the `http` module is patched and we count only there.
         */
        require('http')
      }
    },
    unpatch
  }
]
