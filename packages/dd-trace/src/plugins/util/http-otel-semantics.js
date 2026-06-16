'use strict'

const { extractPathFromUrl } = require('./url')

// OpenTelemetry HTTP semantic-convention attribute names, emitted in place of
// the Datadog ones when `DD_TRACE_OTEL_SEMANTICS_ENABLED` is set.
// See https://opentelemetry.io/docs/specs/semconv/http/http-spans/
const HTTP_REQUEST_METHOD = 'http.request.method'
const HTTP_RESPONSE_STATUS_CODE = 'http.response.status_code'
const URL_FULL = 'url.full'
const URL_PATH = 'url.path'
const URL_SCHEME = 'url.scheme'
const URL_QUERY = 'url.query'
const SERVER_ADDRESS = 'server.address'
const SERVER_PORT = 'server.port'
const USER_AGENT_ORIGINAL = 'user_agent.original'
const CLIENT_ADDRESS = 'client.address'
const NETWORK_PEER_ADDRESS = 'network.peer.address'

/**
 * @typedef {object} ServerUrlParts
 * @property {string} [scheme] value for `url.scheme`
 * @property {string} [address] value for `server.address`
 * @property {number} [port] value for `server.port`
 * @property {string} path value for `url.path`
 * @property {string} [query] value for `url.query` (omitted when empty)
 */

/**
 * Decompose a server request URL into the OpenTelemetry `url.*` / `server.*`
 * parts. Structural fields (scheme, address, port, path) are read from the raw
 * URL; the query is taken from the already-obfuscated URL so the configured
 * query-string obfuscation is preserved.
 *
 * @param {string} rawUrl full request URL (`scheme://host[:port]/path?query`)
 * @param {string} obfuscatedUrl same URL with its query string obfuscated
 * @returns {ServerUrlParts}
 */
function decomposeServerUrl (rawUrl, obfuscatedUrl) {
  let scheme
  let address
  let port
  let path

  try {
    const parsed = new URL(rawUrl)
    scheme = parsed.protocol.length > 1 ? parsed.protocol.slice(0, -1) : undefined
    // `extractURL` builds `http://undefined/...` when the Host header is absent; skip that.
    const hostname = parsed.hostname
    if (hostname && hostname !== 'undefined') {
      // Strip IPv6 brackets so `server.address` carries the bare address.
      address = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
    }
    if (parsed.port) {
      const parsedPort = Number.parseInt(parsed.port)
      if (parsedPort > 0) port = parsedPort
    }
    path = parsed.pathname || '/'
  } catch {
    // Malformed or relative URL: fall back to a best-effort path only.
    path = extractPathFromUrl(rawUrl)
  }

  let query
  const queryIndex = obfuscatedUrl.indexOf('?')
  if (queryIndex !== -1) {
    const rawQuery = obfuscatedUrl.slice(queryIndex + 1)
    if (rawQuery) query = rawQuery
  }

  return { scheme, address, port, path, query }
}

const ERROR_TYPE = 'error.type'

function toHttpScheme (scheme) {
  if (scheme === 'ws') return 'http'
  if (scheme === 'wss') return 'https'
  return scheme
}

/**
 * @typedef {object} FormattedHttpSpan
 * @property {Record<string, string>} meta
 * @property {Record<string, number>} metrics
 * @property {number} error
 */

/**
 * Rewrite a formatted span's Datadog HTTP tags to OpenTelemetry HTTP
 * semantic-convention names, in place. Called at serialization time (from
 * `span_format`) when `DD_TRACE_OTEL_SEMANTICS_ENABLED` is set, so every HTTP
 * integration is covered from one place. No-op for non-HTTP spans. The span
 * keeps the Datadog tag names throughout its lifetime — only the serialized
 * output is renamed — so runtime consumers (peer.service, AppSec, trace stats)
 * are unaffected.
 *
 * @param {FormattedHttpSpan} formattedSpan
 */
function applyHttpOtelSemantics (formattedSpan) {
  const { meta, metrics } = formattedSpan
  const method = meta['http.method']
  const url = meta['http.url']
  if (method === undefined && url === undefined) return

  if (method !== undefined) {
    meta[HTTP_REQUEST_METHOD] = method
    delete meta['http.method']
  }

  const status = meta['http.status_code']
  if (status !== undefined) {
    meta[HTTP_RESPONSE_STATUS_CODE] = status
    delete meta['http.status_code']
  }

  const userAgent = meta['http.useragent']
  if (userAgent !== undefined) {
    meta[USER_AGENT_ORIGINAL] = userAgent
    delete meta['http.useragent']
  }

  const clientIp = meta['http.client_ip']
  if (clientIp !== undefined) {
    meta[CLIENT_ADDRESS] = clientIp
    delete meta['http.client_ip']
  }

  // http.endpoint is a Datadog-only attribute with no OTel equivalent.
  delete meta['http.endpoint']

  if (meta['span.kind'] === 'server') {
    if (url !== undefined) {
      // The query in `http.url` is already obfuscated per config, so it is preserved.
      const { scheme, address, port, path, query } = decomposeServerUrl(url, url)
      if (path !== undefined) meta[URL_PATH] = path
      if (scheme !== undefined) meta[URL_SCHEME] = toHttpScheme(scheme)
      if (query !== undefined) meta[URL_QUERY] = query
      if (address !== undefined) meta[SERVER_ADDRESS] = address
      if (port !== undefined) metrics[SERVER_PORT] = port
      delete meta['http.url']
    }
  } else {
    if (url !== undefined) {
      meta[URL_FULL] = url
      delete meta['http.url']
    }
    const outHost = meta['out.host']
    if (outHost !== undefined) {
      meta[SERVER_ADDRESS] = outHost
      delete meta['out.host']
    }
    const clientPort = metrics['network.destination.port']
    if (clientPort !== undefined) {
      metrics[SERVER_PORT] = clientPort
      delete metrics['network.destination.port']
    }
  }

  // OTel error.type for an error response is the status code, unless an
  // exception already provided a more specific type.
  if (formattedSpan.error && status !== undefined && meta[ERROR_TYPE] === undefined) {
    meta[ERROR_TYPE] = status
  }
}

module.exports = {
  HTTP_REQUEST_METHOD,
  HTTP_RESPONSE_STATUS_CODE,
  URL_FULL,
  URL_PATH,
  URL_SCHEME,
  URL_QUERY,
  SERVER_ADDRESS,
  SERVER_PORT,
  USER_AGENT_ORIGINAL,
  CLIENT_ADDRESS,
  NETWORK_PEER_ADDRESS,
  decomposeServerUrl,
  applyHttpOtelSemantics,
}
