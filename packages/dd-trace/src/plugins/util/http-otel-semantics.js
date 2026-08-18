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
const HTTP_REQUEST_METHOD_ORIGINAL = 'http.request.method_original'
const RESOURCE_SET_BY_USER = '_dd.otel.resource_set_by_user'

// Known HTTP methods (RFC 9110 + PATCH RFC 5789 + QUERY httpbis draft). A verb
// outside this set is reported as `_OTHER` with the raw value preserved on
// `http.request.method_original`, per the OTel HTTP semantic conventions.
const KNOWN_METHODS = new Set([
  'CONNECT', 'DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'QUERY', 'TRACE',
])

function otelHttpResourceName (method, route) {
  const normalizedMethod = KNOWN_METHODS.has(method) ? method : 'HTTP'
  if (typeof route === 'string' && route.length > 0) return `${normalizedMethod} ${route}`
  return normalizedMethod
}

function isInstrumentationHttpResource (resource, method) {
  if (typeof resource !== 'string' || resource.length === 0) return true
  const normalizedMethod = KNOWN_METHODS.has(method) ? method : 'HTTP'
  return resource === method ||
    resource === normalizedMethod ||
    resource.startsWith(`${method} `) ||
    resource.startsWith(`${normalizedMethod} `)
}

function runHttpRequestHook (span, enabled, hook, ...args) {
  const resourceBeforeHook = span.context().getTag('resource.name')
  hook(span, ...args)
  if (enabled && span.context().getTag('resource.name') !== resourceBeforeHook) {
    span.setTag(RESOURCE_SET_BY_USER, 'true')
  }
}

// Datadog HTTP meta keys replaced by OTel names — omitted when rebuilding meta.
// `http.endpoint` is deliberately absent: it is Datadog-only with no OTel
// equivalent, and ASM plus endpoint aggregation read it, so it is retained on
// both the agent and the OTLP payload.
const DD_HTTP_META_KEYS = new Set([
  'http.method', 'http.status_code', 'http.useragent', 'http.client_ip', 'http.url', 'out.host',
  RESOURCE_SET_BY_USER,
])
const NETWORK_DESTINATION_PORT = 'network.destination.port'

// IPv6 literals arrive bracketed (URL.hostname / out.host = `[::1]`); OTel
// `server.address` is the bare address.
function stripIpv6Brackets (host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/**
 * @typedef {object} ServerUrlParts
 * @property {string} [scheme] value for `url.scheme`
 * @property {string} [address] value for `server.address`
 * @property {string} [port] value for `server.port`, kept as the digits the URL
 * already held so no number-to-string round trip is needed at export time
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
      address = stripIpv6Brackets(hostname)
    }
    // `URL` rejects a non-numeric port and normalises away the scheme default, so
    // any value left is valid digits and needs no re-parsing. Port 0 is never a
    // real listening port, so it stays omitted as it was before.
    if (parsed.port && parsed.port !== '0') port = parsed.port
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
 * Redact any userinfo embedded in a URL's authority, since `url.full` must not
 * leak credentials: `user:pass@host` -> `REDACTED:REDACTED@host`, `user@host` ->
 * `REDACTED@host`. Returns the URL unchanged when no userinfo is present.
 *
 * @param {string} url
 * @returns {string}
 */
function redactUrlCredentials (url) {
  const schemeEnd = url.indexOf('://')
  if (schemeEnd === -1) return url
  const authorityStart = schemeEnd + 3

  let authorityEnd = url.length
  for (let i = authorityStart; i < url.length; i++) {
    const char = url[i]
    if (char === '/' || char === '?' || char === '#') {
      authorityEnd = i
      break
    }
  }

  // userinfo runs to the LAST '@' in the authority (WHATWG); using the first
  // '@' would leak the remainder, e.g. `user:p@ss@host`.
  const at = url.lastIndexOf('@', authorityEnd - 1)
  if (at < authorityStart) return url

  const redacted = url.slice(authorityStart, at).includes(':') ? 'REDACTED:REDACTED' : 'REDACTED'
  return url.slice(0, authorityStart) + redacted + url.slice(at)
}

/**
 * The scheme's default port, used as the `server.port` fallback for client spans
 * (the attribute is required for clients but the explicit port is absent for
 * default-port requests). Returned as a string because every attribute leaves on
 * the agent protocol as a `meta` string.
 *
 * @param {string} [url]
 * @returns {string | undefined}
 */
function defaultPortForUrl (url) {
  if (url === undefined) return
  if (url.startsWith('https:') || url.startsWith('wss:')) return '443'
  if (url.startsWith('http:') || url.startsWith('ws:')) return '80'
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
 * integration is covered from one place. No-op for non-HTTP spans. In
 * OTel-semantics mode this runs before trace-stat aggregation, so stats and the
 * OTLP exporter consume the same normalized names and attributes.
 *
 * @param {FormattedHttpSpan} formattedSpan
 */
function applyHttpOtelSemantics (formattedSpan) {
  const meta = formattedSpan.meta
  const metrics = formattedSpan.metrics
  const method = meta['http.method']
  const url = meta['http.url']
  if (method === undefined && url === undefined) return

  // Rebuild meta/metrics as fresh objects that omit the renamed Datadog HTTP
  // keys. Deleting them in place demotes the formatted span to V8 dictionary
  // mode (~40% slower than this rebuild, measured); a fresh object keeps fast
  // properties and can't leak a renamed key as `undefined` on the OTLP path.
  const newMeta = {}
  for (const key of Object.keys(meta)) {
    if (!DD_HTTP_META_KEYS.has(key)) newMeta[key] = meta[key]
  }
  const newMetrics = {}
  for (const key of Object.keys(metrics)) {
    if (key !== NETWORK_DESTINATION_PORT) newMetrics[key] = metrics[key]
  }

  const kind = meta['span.kind']

  if (method !== undefined) {
    if (KNOWN_METHODS.has(method)) {
      newMeta[HTTP_REQUEST_METHOD] = method
    } else {
      // Unknown verb: bucket to `_OTHER`, preserve the raw value, and use the
      // literal "HTTP" in the span name (the spec forbids the URL path there).
      // Known-method names are already `{method} {route}`.
      newMeta[HTTP_REQUEST_METHOD] = '_OTHER'
      newMeta[HTTP_REQUEST_METHOD_ORIGINAL] = method
    }
    // Request hooks mark ownership explicitly because a user resource can have
    // the same method-prefixed shape as an instrumentation-generated resource.
    if (
      meta[RESOURCE_SET_BY_USER] !== 'true' &&
      isInstrumentationHttpResource(formattedSpan.resource, method)
    ) {
      formattedSpan.resource = otelHttpResourceName(method, meta['http.route'])
    }
  }

  const status = meta['http.status_code']
  // Every attribute leaves on the agent protocol as a `meta` string, so the
  // already-stringified status is reused verbatim. OTel types the attribute as an
  // int, which only matters on the OTLP path: `otlp_transformer` promotes this key
  // to `intValue` from its own allowlist, so no numeric copy is needed here.
  if (status !== undefined) newMeta[HTTP_RESPONSE_STATUS_CODE] = status

  const userAgent = meta['http.useragent']
  if (userAgent !== undefined) newMeta[USER_AGENT_ORIGINAL] = userAgent

  const clientIp = meta['http.client_ip']
  if (clientIp !== undefined) newMeta[CLIENT_ADDRESS] = clientIp

  // http.endpoint is Datadog-only (omitted above); it has no OTel equivalent.

  if (kind === 'server') {
    // A server integration that does not populate `http.url` gets no `url.*` /
    // `server.*` attributes, since there is nothing here to derive them from.
    if (url !== undefined) {
      // The query in `http.url` is already obfuscated per config, so it is preserved.
      const { scheme, address, port, path, query } = decomposeServerUrl(url, url)
      if (path !== undefined) newMeta[URL_PATH] = path
      if (scheme !== undefined) newMeta[URL_SCHEME] = toHttpScheme(scheme)
      if (query !== undefined) newMeta[URL_QUERY] = query
      if (address !== undefined) newMeta[SERVER_ADDRESS] = address
      // Already a string of digits from the URL, so no conversion is needed.
      if (port !== undefined) newMeta[SERVER_PORT] = port
    }
  } else {
    if (url !== undefined) {
      // url.full must not carry embedded credentials.
      newMeta[URL_FULL] = redactUrlCredentials(url)
    }
    const outHost = meta['out.host']
    if (outHost !== undefined) newMeta[SERVER_ADDRESS] = stripIpv6Brackets(outHost)
    const clientPort = metrics[NETWORK_DESTINATION_PORT]
    if (clientPort === undefined) {
      // server.port is required for client spans; fall back to the scheme default.
      const defaultPort = defaultPortForUrl(url)
      if (defaultPort !== undefined) newMeta[SERVER_PORT] = defaultPort
    } else {
      newMeta[SERVER_PORT] = String(clientPort)
    }
  }

  // `error.type` describes an error the span already recorded; it never decides
  // whether the span is an error. The status-code rules live at capture time
  // (`web.addStatusError` for servers, the client plugins' `validateStatus`).
  // Trace stats run after this conversion and therefore observe the same error
  // decision and normalized HTTP attributes as the OTLP exporter.
  // No-clobber: an exception already put its class name here. Bounded below at 400
  // so a span that errored for some other reason (a `setTag('error', true)` on a
  // 200) does not end up describing its error as a success status.
  if (status !== undefined && formattedSpan.error && newMeta[ERROR_TYPE] === undefined && Number(status) >= 400) {
    newMeta[ERROR_TYPE] = status
  }

  formattedSpan.meta = newMeta
  formattedSpan.metrics = newMetrics
}

module.exports = {
  NETWORK_PEER_ADDRESS, // imported by web.js (set from req.socket, not at serialization)
  decomposeServerUrl, // exercised directly by the helper spec
  isInstrumentationHttpResource,
  otelHttpResourceName,
  runHttpRequestHook,
  applyHttpOtelSemantics,
}
