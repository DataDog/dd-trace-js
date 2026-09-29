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
const INSTRUMENTATION_HTTP_RESOURCE = '_dd.otel.instrumentation_http_resource'
const HTTP_STATUS_ERROR = '_dd.otel.status_error'

// Known HTTP methods (RFC 9110 + PATCH RFC 5789 + QUERY httpbis draft). A verb
// outside this set is reported as `_OTHER` with the raw value preserved on
// `http.request.method_original`, per the OTel HTTP semantic conventions.
const KNOWN_METHODS = new Set([
  'CONNECT', 'DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'QUERY', 'TRACE',
])

/**
 * The OTel HTTP span name: `{method} {target}`, or the bare method with no target. An unknown
 * verb uses the literal `HTTP`, never the URL path.
 *
 * @param {string} method
 * @param {string} [route]
 */
function otelHttpResourceName (method, route) {
  const normalizedMethod = KNOWN_METHODS.has(method) ? method : 'HTTP'
  if (typeof route === 'string' && route.length > 0) return `${normalizedMethod} ${route}`
  return normalizedMethod
}

/**
 * Record the generated resource so later passes do not overwrite an application change.
 *
 * @param {import('../../opentracing/span')} span
 * @param {string} resource
 */
function setInstrumentationHttpResource (span, resource) {
  span.setTag('resource.name', resource)
  span.setTag(INSTRUMENTATION_HTTP_RESOURCE, resource)
}

// Datadog HTTP meta keys replaced by OTel names — omitted when rebuilding meta.
// `http.endpoint` stays: it has no OTel equivalent and ASM plus endpoint aggregation read it.
const DD_HTTP_META_KEYS = new Set([
  'http.method', 'http.status_code', 'http.useragent', 'http.client_ip', 'http.url', 'out.host',
  INSTRUMENTATION_HTTP_RESOURCE, HTTP_STATUS_ERROR,
])
const NETWORK_DESTINATION_PORT = 'network.destination.port'

// IPv6 literals arrive bracketed (URL.hostname / out.host = `[::1]`); OTel
// `server.address` is the bare address.
const UNSIGNED_INTEGER = /^\d+$/
const INT_VALUED_OTEL_ATTRIBUTES = new Set([HTTP_RESPONSE_STATUS_CODE, SERVER_PORT])

/**
 * Accept only unsigned decimal integers that can be serialized without coercion or precision loss.
 *
 * @param {unknown} value
 */
function isCanonicalIntegerAttribute (value) {
  // `Number.isSafeInteger` rather than `isInteger`: a longer digit string becomes Infinity, which
  // `JSON.stringify` writes as `intValue: null`, and anything past 2^53 is silently rounded.
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0
  return typeof value === 'string' && UNSIGNED_INTEGER.test(value) && Number.isSafeInteger(Number(value))
}

/**
 * Treat a resource that differs from the recorded instrumentation value as application-owned.
 *
 * @param {string | undefined} currentResource
 * @param {string | undefined} instrumentationResource
 */
function isInstrumentationOwnedResource (currentResource, instrumentationResource) {
  return !currentResource || currentResource === instrumentationResource
}

function stripIpv6Brackets (host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/**
 * @typedef {object} ServerUrlParts
 * @property {string} [scheme] value for `url.scheme`
 * @property {string} [address] value for `server.address`
 * @property {string} [port] value for `server.port`
 * @property {string} path value for `url.path`
 * @property {string} [query] value for `url.query` (omitted when empty)
 */

/**
 * Decompose a server request URL into the OpenTelemetry `url.*` / `server.*`
 * parts. Structural fields (scheme, address, path) are read from the raw URL;
 * the port is explicit or inferred from the scheme. The query comes from the
 * already-obfuscated URL so configured query-string obfuscation is preserved.
 *
 * TODO: Replace both parameters with one already-obfuscated URL. All production callers pass the
 * same value for both.
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
      port = parsed.port || defaultPortForUrl(rawUrl)
      if (port === '0') port = undefined
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
 * Redact any userinfo embedded in a URL's authority, since `url.full` must not
 * leak credentials. Any userinfo becomes `REDACTED:REDACTED@host`, matching OpenTelemetry HTTP
 * instrumentation. Returns the URL unchanged when no userinfo is present.
 *
 * @param {string} url
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

  return url.slice(0, authorityStart) + 'REDACTED:REDACTED' + url.slice(at)
}

/**
 * Return the required client `server.port` when the URL omits its default port.
 *
 * @param {string} [url]
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
 * integration is covered from one place. Runs ahead of trace-stat aggregation, so stats and
 * the OTLP exporter see the same attributes.
 *
 * @param {FormattedHttpSpan} formattedSpan
 */
function applyHttpOtelSemantics (formattedSpan) {
  const meta = formattedSpan.meta
  const metrics = formattedSpan.metrics
  const method = meta['http.method']
  const url = meta['http.url']
  // Hooks can remove the method and URL; the resource marker still identifies HTTP spans whose
  // remaining tags need renaming.
  if (method === undefined && url === undefined && meta[INSTRUMENTATION_HTTP_RESOURCE] === undefined) {
    // Rebuild to remove an orphaned internal marker without demoting `meta` to V8 dictionary mode.
    if (Object.hasOwn(meta, HTTP_STATUS_ERROR)) {
      const cleanMeta = {}
      for (const key of Object.keys(meta)) {
        if (key !== HTTP_STATUS_ERROR) cleanMeta[key] = meta[key]
      }
      formattedSpan.meta = cleanMeta
    }
    return
  }

  // Rebuild meta/metrics as fresh objects that omit the renamed Datadog HTTP
  // keys. Deleting them in place demotes the formatted span to V8 dictionary
  // mode (~40% slower than this rebuild, measured); a fresh object keeps fast
  // properties and can't leak a renamed key as `undefined` on the OTLP path.
  const newMeta = {}
  for (const key of Object.keys(meta)) {
    if (!DD_HTTP_META_KEYS.has(key)) newMeta[key] = meta[key]
  }

  const kind = meta['span.kind']

  if (method !== undefined) {
    if (KNOWN_METHODS.has(method)) {
      newMeta[HTTP_REQUEST_METHOD] = method
    } else {
      newMeta[HTTP_REQUEST_METHOD] = '_OTHER'
      newMeta[HTTP_REQUEST_METHOD_ORIGINAL] = method
    }
    // Comparing against the recorded value keeps a manual resource shaped like "GET /custom".
    if (isInstrumentationOwnedResource(formattedSpan.resource, meta[INSTRUMENTATION_HTTP_RESOURCE])) {
      formattedSpan.resource = otelHttpResourceName(method, meta['http.route'])
    }
  }

  const status = meta['http.status_code']
  // Keep agent payload string-typed; the OTLP transformer restores the integer type.
  if (status !== undefined) newMeta[HTTP_RESPONSE_STATUS_CODE] = status

  const userAgent = meta['http.useragent']
  if (userAgent !== undefined) newMeta[USER_AGENT_ORIGINAL] = userAgent

  const clientIp = meta['http.client_ip']
  if (clientIp !== undefined) newMeta[CLIENT_ADDRESS] = clientIp

  if (kind === 'server') {
    if (url !== undefined) {
      // The query in `http.url` is already obfuscated per config, so it is preserved.
      const { scheme, address, port, path, query } = decomposeServerUrl(url, url)
      if (path !== undefined) newMeta[URL_PATH] = path
      if (scheme !== undefined) newMeta[URL_SCHEME] = toHttpScheme(scheme)
      if (query !== undefined) newMeta[URL_QUERY] = query
      if (address !== undefined) newMeta[SERVER_ADDRESS] = address
      if (port !== undefined) newMeta[SERVER_PORT] = port
    }
  } else {
    if (url !== undefined) {
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

  // Configured validators, not a fixed status range, decide whether status caused the error.
  // Match the recorded status so a hook replacement is not blamed, and keep exception-derived types.
  const statusCausedError = status !== undefined && meta[HTTP_STATUS_ERROR] === status
  if (formattedSpan.error && newMeta[ERROR_TYPE] === undefined && statusCausedError) {
    newMeta[ERROR_TYPE] = status
  }

  // Drop same-name metrics only when `meta` supplies the OTLP integer, avoiding duplicate types
  // without losing a metric supplied directly by a hook.
  const newMetrics = {}
  for (const key of Object.keys(metrics)) {
    if (key === NETWORK_DESTINATION_PORT) continue
    if (INT_VALUED_OTEL_ATTRIBUTES.has(key) && newMeta[key] !== undefined) continue
    newMetrics[key] = metrics[key]
  }

  formattedSpan.meta = newMeta
  formattedSpan.metrics = newMetrics
}

module.exports = {
  HTTP_STATUS_ERROR,
  INSTRUMENTATION_HTTP_RESOURCE,
  NETWORK_PEER_ADDRESS, // imported by web.js (set from req.socket, not at serialization)
  decomposeServerUrl, // exercised directly by the helper spec
  INT_VALUED_OTEL_ATTRIBUTES,
  isCanonicalIntegerAttribute,
  isInstrumentationOwnedResource,
  otelHttpResourceName,
  setInstrumentationHttpResource,
  applyHttpOtelSemantics,
}
