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

function otelHttpResourceName (method, route) {
  const normalizedMethod = KNOWN_METHODS.has(method) ? method : 'HTTP'
  if (typeof route === 'string' && route.length > 0) return `${normalizedMethod} ${route}`
  return normalizedMethod
}

function runHttpRequestHook (span, hook, arg1, arg2) {
  hook(span, arg1, arg2)
}

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
// The int-typed OTel attributes (`server.port`, `http.response.status_code`) are unsigned
// integers. Matching them exactly keeps `Number` away from the values it coerces into a
// plausible one: '', whitespace, '0x10', '1e2', ' 200 '. Trace metrics and the OTLP exporter
// both validate through here so they cannot disagree about what a status is.
const UNSIGNED_INTEGER = /^\d+$/
const INT_VALUED_OTEL_ATTRIBUTES = new Set([HTTP_RESPONSE_STATUS_CODE, SERVER_PORT])

function isCanonicalIntegerAttribute (value) {
  // `Number.isSafeInteger` rather than `isInteger`: a longer digit string becomes Infinity, which
  // `JSON.stringify` writes as `intValue: null`, and anything past 2^53 is silently rounded.
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0
  return typeof value === 'string' && UNSIGNED_INTEGER.test(value) && Number.isSafeInteger(Number(value))
}

/**
 * Whether the instrumentation still owns a resource, and so may overwrite it.
 * `INSTRUMENTATION_HTTP_RESOURCE` holds the value the instrumentation last wrote, so anything
 * different came from application code and has to survive. An unset resource is unowned.
 *
 * @param {string | undefined} currentResource
 * @param {string | undefined} instrumentationResource
 * @returns {boolean}
 */
function isInstrumentationOwnedResource (currentResource, instrumentationResource) {
  if (!currentResource) return true
  return currentResource === instrumentationResource
}

function stripIpv6Brackets (host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/**
 * @typedef {object} ServerUrlParts
 * @property {string} [scheme] value for `url.scheme`
 * @property {string} [address] value for `server.address`
 * @property {string} [port] value for `server.port`, as the digits the URL already held
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
    // `URL` rejects non-numeric ports and drops the scheme default, so what is left is digits.
    // Port 0 is never a real listening port.
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
 * default-port requests). A string, like every other attribute on the agent protocol.
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
  if (method === undefined && url === undefined && meta[INSTRUMENTATION_HTTP_RESOURCE] === undefined) {
    // Not a span this layer touched. A hook that strips the method and URL from one it did touch
    // leaves the marker behind, and the status and user agent it captured at finish still have to
    // be renamed, so that case falls through instead.
    delete meta[HTTP_STATUS_ERROR]
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
      // Unknown verb: bucket to `_OTHER`, preserve the raw value, and use the
      // literal "HTTP" in the span name (the spec forbids the URL path there).
      // Known-method names are already `{method} {route}`.
      newMeta[HTTP_REQUEST_METHOD] = '_OTHER'
      newMeta[HTTP_REQUEST_METHOD_ORIGINAL] = method
    }
    // Comparing against the recorded value keeps a manual resource shaped like "GET /custom".
    if (isInstrumentationOwnedResource(formattedSpan.resource, meta[INSTRUMENTATION_HTTP_RESOURCE])) {
      formattedSpan.resource = otelHttpResourceName(method, meta['http.route'])
    }
  }

  const status = meta['http.status_code']
  // Reused as the `meta` string the agent protocol needs. OTel types this as an int, which
  // only matters over OTLP, where `otlp_transformer` promotes it from its own allowlist.
  if (status !== undefined) newMeta[HTTP_RESPONSE_STATUS_CODE] = status

  const userAgent = meta['http.useragent']
  if (userAgent !== undefined) newMeta[USER_AGENT_ORIGINAL] = userAgent

  const clientIp = meta['http.client_ip']
  if (clientIp !== undefined) newMeta[CLIENT_ADDRESS] = clientIp

  // http.endpoint is Datadog-only (omitted above); it has no OTel equivalent.

  if (kind === 'server') {
    // Without `http.url` there is nothing to derive `url.*` / `server.*` from.
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

  // `error.type` names the cause of an error the span already carries; it never decides
  // whether the span is an error. Only capture time knows whether the status was that cause
  // (`web.addStatusError`, the client plugins' `validateStatus`), so nothing is inferred from
  // the status range here. No-clobber on an exception-derived type.
  const statusCausedError = meta[HTTP_STATUS_ERROR] === 'true'
  if (
    status !== undefined &&
    formattedSpan.error &&
    newMeta[ERROR_TYPE] === undefined &&
    statusCausedError
  ) {
    newMeta[ERROR_TYPE] = status
  }

  // Built once `newMeta` is final. An int-typed OTel attribute is promoted from `meta` at export,
  // so a numeric copy a hook left in `metrics` would be exported a second time with its own
  // value. It is dropped only where a derived replacement actually exists, otherwise a hook that
  // supplies the canonical attribute without its legacy counterpart would lose it entirely.
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
  runHttpRequestHook,
  setInstrumentationHttpResource,
  applyHttpOtelSemantics,
}
