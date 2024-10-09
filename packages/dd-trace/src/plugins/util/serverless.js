const tags = require('../../../../../ext/tags')
const types = require('../../../../../ext/types')
const kinds = require('../../../../../ext/kinds')
const web = require('./web')

const SERVERLESS = types.SERVERLESS
const SERVER = kinds.SERVER
const RESOURCE_NAME = tags.RESOURCE_NAME
const SPAN_TYPE = tags.SPAN_TYPE
const SPAN_KIND = tags.SPAN_KIND
const HTTP_METHOD = tags.HTTP_METHOD
const HTTP_STATUS_CODE = tags.HTTP_STATUS_CODE
const HTTP_ROUTE = tags.HTTP_ROUTE
const HTTP_REQUEST_HEADERS = tags.HTTP_REQUEST_HEADERS
const HTTP_RESPONSE_HEADERS = tags.HTTP_RESPONSE_HEADERS
const HTTP_URL = tags.HTTP_URL
const HTTP_USERAGENT = tags.HTTP_USERAGENT
const HTTP_CLIENT_IP = tags.HTTP_CLIENT_IP

const HTTP2_HEADER_AUTHORITY = ':authority'
const HTTP2_HEADER_SCHEME = ':scheme'
const HTTP2_HEADER_PATH = ':path'

const serverless = {
  finishSpan (context) {
    const { req, res } = context

    if (context.finished && !req.stream) return

    addRequestTags(context)
    addResponseTags(context)

    context.config.hooks.request(context.span, req, res)
    addResourceTag(context)

    context.span.finish()
    context.finished = true
  }
}

function addRequestTags (context) {
  const { req, span, config } = context
  const url = extractURL(req)

  span.addTags({
    [HTTP_URL]: web.obfuscateQs(config, url),
    [HTTP_METHOD]: req.method,
    [SPAN_KIND]: SERVER,
    [SPAN_TYPE]: SERVERLESS,
    [HTTP_USERAGENT]: req.headers['user-agent']
  })

  // if client ip has already been set by appsec, no need to run it again
  if (config.clientIpEnabled && !span.context()._tags.hasOwnProperty(HTTP_CLIENT_IP)) {
    const clientIp = web.extractIp(config, req)

    if (clientIp) {
      span.setTag(HTTP_CLIENT_IP, clientIp)
    }
  }

  addHeaders(context)
}

function addResponseTags (context) {
  const { req, res, paths, span } = context

  if (paths.length > 0) {
    span.setTag(HTTP_ROUTE, paths.join(''))
  }

  span.addTags({
    [HTTP_STATUS_CODE]: res.status
  })

  web.addStatusError(req, res.status)
}

function extractURL (req) {
  const headers = req.headers

  if (req.stream) {
    return `${headers[HTTP2_HEADER_SCHEME]}://${headers[HTTP2_HEADER_AUTHORITY]}${headers[HTTP2_HEADER_PATH]}`
  } else {
    const protocol = getProtocol(req)
    return `${protocol}://${req.headers.host}${req.originalUrl || req.url}`
  }
}

function getProtocol (req) {
  if (req.socket && req.socket.encrypted) return 'https'
  if (req.connection && req.connection.encrypted) return 'https'

  return 'http'
}

function addHeaders (context) {
  const { req, res, config, span } = context

  config.headers.forEach(([key, tag]) => {
    const reqHeader = req.headers[key]
    const resHeader = res.getHeader(key)

    if (reqHeader) {
      span.setTag(tag || `${HTTP_REQUEST_HEADERS}.${key}`, reqHeader)
    }

    if (resHeader) {
      span.setTag(tag || `${HTTP_RESPONSE_HEADERS}.${key}`, resHeader)
    }
  })
}

function addResourceTag (context) {
  const { req, span } = context
  const tags = span.context()._tags

  if (tags['resource.name']) return

  const resource = [req.method, tags[HTTP_ROUTE]]
    .filter(val => val)
    .join(' ')

  span.setTag(RESOURCE_NAME, resource)
}

module.exports = serverless
