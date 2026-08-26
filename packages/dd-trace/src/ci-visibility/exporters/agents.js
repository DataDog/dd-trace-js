'use strict'

const http = require('node:http')
const https = require('node:https')

const { storage } = require('../../../../datadog-core')
const { parseUrl } = require('../../exporters/common/url')

const legacyStorage = storage('legacy')

// Test Optimization flushes many payloads near process exit. The shared exporter
// agents cap at a single socket per origin, so concurrent payloads queue behind
// one connection and the bounded final flush aborts the backlog. A dedicated
// pool with bounded concurrency drains the queue in parallel instead.
const MAX_SOCKETS = 16
const agentOptions = { keepAlive: true, maxSockets: MAX_SOCKETS }

/**
 * Creates a Test Optimization agent class whose socket lifecycle cannot be traced.
 *
 * The socket lifecycle hooks run outside the active trace context so connection
 * setup, keep-alive, and reuse never generate tracer telemetry. The implementation
 * mirrors `exporters/common/agents.js`; keeping it local lets Test Optimization
 * use independent connection limits without affecting agents shared by other products.
 *
 * @param {typeof http.Agent|typeof https.Agent} BaseAgent
 * @returns {typeof http.Agent|typeof https.Agent}
 */
function createAgentClass (BaseAgent) {
  class TestOptimizationAgent extends BaseAgent {
    /**
     * Creates a Test Optimization HTTP(S) agent.
     */
    constructor () {
      super(agentOptions)
    }

    /**
     * Creates a socket outside the active trace context.
     *
     * @param {...unknown} args
     * @returns {import('node:stream').Duplex}
     */
    createConnection (...args) {
      return this._noop(() => super.createConnection(...args))
    }

    /**
     * Keeps an idle socket alive outside the active trace context.
     *
     * @param {...unknown} args
     * @returns {boolean}
     */
    keepSocketAlive (...args) {
      return this._noop(() => super.keepSocketAlive(...args))
    }

    /**
     * Reuses a socket outside the active trace context.
     *
     * @param {...unknown} args
     * @returns {void}
     */
    reuseSocket (...args) {
      return this._noop(() => super.reuseSocket(...args))
    }

    /**
     * Runs a socket operation without generating tracer telemetry.
     *
     * @template T
     * @param {() => T} callback
     * @returns {T}
     */
    _noop (callback) {
      return legacyStorage.run({ noop: true }, callback)
    }
  }

  return TestOptimizationAgent
}

const HttpAgent = createAgentClass(http.Agent)
const HttpsAgent = createAgentClass(https.Agent)

const httpAgent = new HttpAgent()
const httpsAgent = new HttpsAgent()

// Telemetry gets its own pool so lifecycle telemetry cannot occupy sockets that
// the bounded final flush waits on, and vice versa, when a custom intake URL
// would otherwise route both through the same origin singleton.
const telemetryHttpAgent = new HttpAgent()
const telemetryHttpsAgent = new HttpsAgent()

/**
 * Normalizes a URL-like value to a `URL` object.
 *
 * @param {string|URL|object} url
 * @returns {URL|null}
 */
function toURL (url) {
  try {
    return url instanceof URL ? url : new URL(url)
  } catch {
    return null
  }
}

/**
 * Selects the dedicated Test Optimization payload agent for an intake URL.
 *
 * @param {string|URL|object} url
 * @returns {http.Agent|https.Agent}
 */
function getAgent (url) {
  return selectAgent(url, httpAgent, httpsAgent)
}

/**
 * Selects the dedicated Test Optimization telemetry agent for an intake URL.
 *
 * Telemetry uses a separate pool from payload writers so lifecycle telemetry
 * cannot occupy sockets the bounded final flush waits on when a custom intake
 * URL would otherwise route both through the same origin singleton.
 *
 * @param {string|URL|object} url
 * @returns {http.Agent|https.Agent}
 */
function getTelemetryAgent (url) {
  return selectAgent(url, telemetryHttpAgent, telemetryHttpsAgent)
}

/**
 * Selects between an HTTP and HTTPS agent by protocol.
 *
 * @param {string|URL|object} url
 * @param {http.Agent} httpPool
 * @param {https.Agent} httpsPool
 * @returns {http.Agent|https.Agent}
 */
function selectAgent (url, httpPool, httpsPool) {
  const protocol = url?.protocol
  if (protocol === 'https:' || protocol === 'https') return httpsPool
  if (protocol === 'http:' || protocol === 'http') return httpPool

  const parsed = toURL(url)
  const isSecure = parsed ? parsed.protocol === 'https:' : String(url).startsWith('https:')
  return isSecure ? httpsPool : httpPool
}

/**
 * Reports whether an agent's origin pool is saturated.
 *
 * Returns `true` when every socket for the origin is in flight or a request is
 * already queued behind them. Periodic flushes use this to coalesce events
 * instead of stacking another request onto a busy origin. Fails open (`false`)
 * when the origin state cannot be determined so flushes are never blocked by an
 * inspection error.
 *
 * @param {string|URL|object} url
 * @param {http.Agent|https.Agent} [agent] defaults to the dedicated agent for `url`
 * @returns {boolean}
 */
function isOriginSaturated (url, agent = getAgent(url)) {
  // Normalize the URL with the same conversion the transport uses (urlToHttpOptions)
  // so the origin key matches the one Node assigns in the agent's socket map:
  // IPv6 brackets are stripped, a default port (443 / 80) is applied when the URL
  // omits one, and Unix-domain sockets are keyed by their path. Without this, the
  // probe keys never match and saturation is never detected for IPv6 literals,
  // default-port intake URLs, or EVP-capable Agents reached over a Unix socket.
  let parsed
  try {
    parsed = typeof url === 'string' || url instanceof URL ? parseUrl(url) : url
  } catch {
    return false
  }
  if (!parsed) return false

  let name
  if (parsed.protocol === 'unix:') {
    if (!parsed.pathname) return false
    // Node still applies the http default port (80) to the agent key for a
    // Unix-socket request, so probe with it to match.
    name = agent.getName({ port: 80, socketPath: parsed.pathname })
  } else {
    if (!parsed.hostname) return false
    const port = parsed.port || (parsed.protocol === 'https:' ? 443 : 80)
    name = agent.getName({ host: parsed.hostname, port })
  }

  const activeSockets = agent.sockets?.[name]?.length || 0
  const queuedRequests = agent.requests?.[name]?.length || 0

  return activeSockets >= agent.maxSockets || queuedRequests > 0
}

module.exports = { getAgent, getTelemetryAgent, isOriginSaturated }
