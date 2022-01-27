'use strict'

const web = require('../../dd-trace/src/plugins/util/web')
const shimmer = require('../../datadog-shimmer')

const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const tags = require('../../../ext/tags')
const types = require('../../../ext/types')
const kinds = require('../../../ext/kinds')

const WEB = types.WEB
const SERVER = kinds.SERVER
const RESOURCE_NAME = tags.RESOURCE_NAME
const SERVICE_NAME = tags.SERVICE_NAME
const SPAN_TYPE = tags.SPAN_TYPE
const SPAN_KIND = tags.SPAN_KIND
const HTTP_METHOD = tags.HTTP_METHOD
const HTTP_URL = tags.HTTP_URL
const HTTP_STATUS_CODE = tags.HTTP_STATUS_CODE
const HTTP_ROUTE = tags.HTTP_ROUTE
const HTTP_REQUEST_HEADERS = tags.HTTP_REQUEST_HEADERS
const HTTP_RESPONSE_HEADERS = tags.HTTP_RESPONSE_HEADERS
const MANUAL_DROP = tags.MANUAL_DROP

const HTTP_STATUS_OK = 200
const HTTP2_HEADER_AUTHORITY = ':authority'
const HTTP2_HEADER_SCHEME = ':scheme'
const HTTP2_HEADER_METHOD = ':method'
const HTTP2_HEADER_PATH = ':path'
const HTTP2_HEADER_STATUS = ':status'

function createWrapEmit (tracer, config) {
  return function wrapEmit (emit) {
    return function emitWithTrace (event, arg1, arg2) {
      if (event === 'stream') {
        const stream = arg1
        const headers = arg2
        return instrumentStream(tracer, config, stream, headers, 'http.request', () => {
          return emit.apply(this, arguments)
        })
      } else if (event === 'request') {
        const req = arg1
        const res = arg2
        return web.instrument(tracer, config, req, res, 'http.request', () => {
          return emit.apply(this, arguments)
        })
      } else {
        return emit.apply(this, arguments)
      }
    }
  }
}

function createWrapCreateServer (tracer, config) {
  config = web.normalizeConfig(config)

  return function wrapCreateServer (createServer) {
    return function createServerWithTrace (args) {
      const server = createServer.apply(this, arguments)

      shimmer.wrap(server, 'emit', createWrapEmit(tracer, config))

      return server
    }
  }
}

function instrumentStream (tracer, config, stream, headers, name, callback) {
  if (!stream) return callback()

  headers = headers || {}

  web.patch(stream)

  const span = startStreamSpan(tracer, config, stream, headers, name)

  if (!config.filter(headers[HTTP2_HEADER_PATH])) {
    span.setTag(MANUAL_DROP, true)
  }

  if (config.service) {
    span.setTag(SERVICE_NAME, config.service)
  }

  analyticsSampler.sample(span, config.measured, true)

  wrapStreamEnd(stream)

  addRequestTags(stream, headers)
  addRequestHeaders(stream, headers)
  addResourceTags(stream, headers)

  return callback && tracer.scope().activate(span, () => callback(span))
}

function startStreamSpan (tracer, config, stream, headers, name) {
  stream._datadog.config = config

  if (stream._datadog.span) {
    return stream._datadog.span
  }

  const span = web.startChildSpan(tracer, name, headers)

  stream._datadog.tracer = tracer
  stream._datadog.span = span

  return span
}

function wrapStreamEnd (stream) {
  function wrapEnd (end) {
    return function endWithTrace () {
      const returnValue = end.apply(this, arguments)

      finishStream(stream)
      return returnValue
    }
  }

  shimmer.wrap(stream, 'end', wrapEnd)
}

function finishStream (stream) {
  if (stream._datadog.finished) return

  addResponseTags(stream)
  addResponseHeaders(stream)

  stream._datadog.span.finish()
  stream._datadog.finished = true
}

function addRequestTags (stream, headers) {
  const span = stream._datadog.span
  const url = `${headers[HTTP2_HEADER_SCHEME]}://${headers[HTTP2_HEADER_AUTHORITY]}${headers[HTTP2_HEADER_PATH]}`

  span.addTags({
    [HTTP_METHOD]: headers[HTTP2_HEADER_METHOD],
    [HTTP_URL]: url.split('?')[0],
    [SPAN_KIND]: SERVER,
    [SPAN_TYPE]: WEB
  })
}

function addRequestHeaders (stream, headers) {
  if (!headers) return

  const span = stream._datadog.span

  stream._datadog.config.headers.forEach(key => {
    const reqHeader = headers[key]

    if (reqHeader) {
      span.setTag(`${HTTP_REQUEST_HEADERS}.${key}`, reqHeader)
    }
  })
}

function addResponseTags (stream) {
  const span = stream._datadog.span
  const headers = stream.sentHeaders
  const statusCode = headers[HTTP2_HEADER_STATUS]

  span.addTags({
    [HTTP_STATUS_CODE]: statusCode | 0 || HTTP_STATUS_OK
  })

  web.addStatusError(stream, statusCode)
}

function addResponseHeaders (stream) {
  if (!stream.sentHeaders) return

  const span = stream._datadog.span

  stream._datadog.config.headers.forEach(key => {
    const resHeader = stream.sentHeaders && stream.sentHeaders[key]

    if (resHeader) {
      span.setTag(`${HTTP_RESPONSE_HEADERS}.${key}`, resHeader)
    }
  })
}

function addResourceTags (stream, headers) {
  const span = stream._datadog.span
  const tags = span.context()._tags
  const method = headers[HTTP2_HEADER_METHOD]

  if (tags[RESOURCE_NAME]) return

  const resource = [method]
    .concat(tags[HTTP_ROUTE])
    .filter(val => val)
    .join(' ')

  span.setTag(RESOURCE_NAME, resource)
}

module.exports = [
  {
    name: 'http2',
    patch (http2, tracer, config) {
      if (config.server === false) return

      this.wrap(http2, 'createServer', createWrapCreateServer(tracer, config))
      this.wrap(http2, 'createSecureServer', createWrapCreateServer(tracer, config))
    },
    unpatch (http2) {
      this.unwrap(http2, 'createServer')
      this.unwrap(http2, 'createSecureServer')
    }
  }
]

module.exports = [] // temporarily disable HTTP2 server plugin
