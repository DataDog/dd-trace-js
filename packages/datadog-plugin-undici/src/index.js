'use strict'

const url = require('url')
const log = require('../../dd-trace/src/log')
const tags = require('../../../ext/tags')
const kinds = require('../../../ext/kinds')
const formats = require('../../../ext/formats')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const { AsyncResource, AsyncLocalStorage } = require('async_hooks')
const {
  addErrorToSpan,
  getServiceName,
  hasAmazonSignature,
  client: { normalizeConfig }
} = require('../../dd-trace/src/plugins/util/web')

const HTTP_HEADERS = formats.HTTP_HEADERS
const HTTP_STATUS_CODE = tags.HTTP_STATUS_CODE
const HTTP_REQUEST_HEADERS = tags.HTTP_REQUEST_HEADERS
const HTTP_RESPONSE_HEADERS = tags.HTTP_RESPONSE_HEADERS
const SPAN_KIND = tags.SPAN_KIND
const CLIENT = kinds.CLIENT

const asyncLocalStorage = new AsyncLocalStorage()

function parseHeaders (headers) {
  const pairs = headers
    .split('\r\n')
    .map((r) => r.split(':').map((str) => str.trim()))

  const object = {}
  pairs.forEach(([key, value]) => {
    key = key.toLowerCase()
    if (!value) {
      return
    }
    if (object[key]) {
      if (!Array.isArray(object[key])) {
        object[key] = [object[key], value]
      } else {
        object[key].push(value)
      }
    } else {
      object[key] = value
    }
  })
  return object
}
const channels = {
  requestChannel: undefined,
  headersChannel: undefined,
  errorChannel: undefined
}

function diagnostics (tracer, config) {
  let diagnosticsChannel
  try {
    diagnosticsChannel = require('diagnostics_channel')
  } catch (e) {
    log.error(
      "Unable to configure undici, cannot require 'diagnostics_channel'"
    )
    return () => {}
  }

  channels.requestChannel = diagnosticsChannel.channel('undici:request:create')
  channels.headersChannel = diagnosticsChannel.channel(
    'undici:request:headers'
  )
  channels.errorChannel = diagnosticsChannel.channel('undici:request:error')

  channels.requestChannel.subscribe(handleRequestCreate)
  channels.errorChannel.subscribe(handleRequestError)
  channels.headersChannel.subscribe(handleRequestHeaders)

  const requestSpansMap = new WeakMap()

  function handleRequestCreate ({ request }) {
    const method = (request.method || 'GET').toUpperCase()

    const path = request.path ? request.path.split(/[?#]/)[0] : '/'
    const uri = `${request.origin}${path}`

    const span = asyncLocalStorage.getStore()
    if (span) {
      span.addTags({
        'resource.name': method,
        'span.type': 'http',
        'http.method': method,
        'http.url': uri,
        'service.name': getServiceName(tracer, config, request.origin)
      })
      requestSpansMap.set(request, span)
    }

    const headers =
      typeof request.headers === 'string'
        ? parseHeaders(request.headers)
        : request.headers

    if (
      !(
        hasAmazonSignature({ ...request, headers }) ||
        !config.propagationFilter(uri)
      )
    ) {
      const injectedHeaders = {}
      tracer.inject(span, HTTP_HEADERS, injectedHeaders)
      Object.entries(injectedHeaders).forEach(([key, value]) => {
        request.addHeader(key, value)
      })
    }

    analyticsSampler.sample(span, config.measured)
  }

  function handleRequestError ({ request, error }) {
    const span = requestSpansMap.get(request)
    addErrorToSpan(span, error)
    addRequestHeaders(request, span, config)
    span.finish()
  }

  function handleRequestHeaders ({ request, response }) {
    const span = requestSpansMap.get(request)
    addRequestHeaders(request, span, config)
    setStatusCode(response, span, config)
    config.hooks.request(span, request, response)
  }

  return function unsubscribe () {
    if (channels.requestChannel.hasSubscribers) {
      channels.requestChannel.unsubscribe(handleRequestCreate)
    }
    if (channels.headersChannel.hasSubscribers) {
      channels.headersChannel.unsubscribe(handleRequestHeaders)
    }
    if (channels.errorChannel.hasSubscribers) {
      channels.errorChannel.unsubscribe(handleRequestError)
    }
  }
}

function addRequestHeaders (req, span, config) {
  const headers = parseHeaders(req.headers)
  Object.entries(headers).forEach(([key, value]) => {
    span.setTag(`${HTTP_REQUEST_HEADERS}.${key}`, value)
  })

  if (!headers.host) {
    // req.servername holds the value of the host header
    if (req.servername) {
      span.setTag(`${HTTP_REQUEST_HEADERS}.host`, req.servername)
    } else {
      // Undici's host header are written directly
      // to the stream, and not passed to the `Request` object
      // This workaround ensure we set the host if
      // it was not explicitely provided
      const { hostname, port } = url.parse(req.origin)
      const host = `${hostname}${port ? `:${port}` : ''}`
      span.setTag(`${HTTP_REQUEST_HEADERS}.host`, host)
    }
  }
}

function setStatusCode (res, span, config) {
  // fetch has status set on `status` rather than statusCode
  const statusCode = res.status || res.statusCode
  span.setTag(HTTP_STATUS_CODE, statusCode)

  if (!config.validateStatus(statusCode)) {
    span.setTag('error', 1)
  }
}

function addResponseHeaders (res, span, config) {
  config.headers.forEach((key) => {
    const value = res.headers[key]

    if (value) {
      span.setTag(`${HTTP_RESPONSE_HEADERS}.${key}`, value)
    }
  })
}

function finishSpan (res, span, error, config) {
  if (res) {
    setStatusCode(res, span, config)
    addResponseHeaders(res, span, config)
    span.finish()
  } else {
    span.setTag('error', 1)
  }
}

function patch (undici, methodName, tracer, config) {
  this.wrap(undici, methodName, (fn) => makeRequestTrace(fn))

  function makeRequestTrace (request) {
    return function requestTrace () {
      // Bind the callback for async resources
      if (arguments.length === 3) {
        arguments[2] = AsyncResource.bind(arguments[2])
      }
      const scope = tracer.scope()
      const childOf = scope.active()
      const span = tracer.startSpan(`undici.${methodName}`, {
        childOf,
        tags: {
          [SPAN_KIND]: CLIENT
        }
      })
      const result = asyncLocalStorage.run(span, () => {
        return tracer.scope().activate(span, () => {
          return request.apply(this, arguments)
        })
      })

      if (methodName === 'pipeline') {
        result.on('end', () => {
          span.finish()
        }).on('error', () => {
          span.finish()
        })
        return result
      }

      return wrapPromise(result, span, config)
    }
  }
}

function wrapPromise (promise, span, config) {
  if (!promise) {
    finishSpan(null, span, null, config)
    return promise
  }

  return promise
    .then(
      (res) => finishSpan(res, span, null, config),
      (e) => finishSpan(null, span, e, config)
    )
    .then(() => promise)
}

module.exports = [
  {
    name: 'undici',
    versions: ['>=4.7.1'],
    patch: function (undici, tracer, config) {
      config = normalizeConfig(config)

      patch.call(this, undici, 'request', tracer, config)
      patch.call(this, undici, 'upgrade', tracer, config)
      patch.call(this, undici, 'connect', tracer, config)
      if (undici.fetch) {
        patch.call(this, undici, 'fetch', tracer, config)
      }
      patch.call(this, undici, 'pipeline', tracer, config)
      patch.call(this, undici, 'stream', tracer, config)

      patch.call(this, undici.Client.prototype, 'request', tracer, config)
      patch.call(this, undici.Client.prototype, 'pipeline', tracer, config)
      patch.call(this, undici.Client.prototype, 'upgrade', tracer, config)
      patch.call(this, undici.Client.prototype, 'connect', tracer, config)
      patch.call(this, undici.Client.prototype, 'stream', tracer, config)

      const unpatchDiagnostics = diagnostics.call(this, tracer, config)

      this.unpatch = () => {
        this.unwrap(undici, 'request')
        this.unwrap(undici, 'upgrade')
        this.unwrap(undici, 'connect')
        if (undici.fetch) {
          this.unwrap(undici, 'fetch')
        }
        this.unwrap(undici, 'pipeline')
        this.unwrap(undici, 'stream')

        this.unwrap(undici.Client.prototype, 'request')
        this.unwrap(undici.Client.prototype, 'pipeline')
        this.unwrap(undici.Client.prototype, 'upgrade')
        this.unwrap(undici.Client.prototype, 'connect')
        this.unwrap(undici.Client.prototype, 'stream')

        unpatchDiagnostics()
      }
    }
  }
]
