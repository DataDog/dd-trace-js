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
}
