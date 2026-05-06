'use strict'

const RATE_LIMIT_MAX_WAIT_MS = 30_000

const SINGLE_RETRY_BASE_MS = 5000
const SINGLE_RETRY_JITTER_MS = 2500

const STARTUP_GRACE_MS = 30_000
const STARTUP_BACKOFF_BASE_MS = 1000
const STARTUP_BACKOFF_MAX_MS = 8000
const STARTUP_BACKOFF_JITTER_MS = 500
const STARTUP_MAX_ATTEMPTS = 5
const POST_STARTUP_MAX_ATTEMPTS = 2

// `ECONNREFUSED` and `ENOENT` cover the agent-not-yet-listening cases (TCP and
// UDS). `EAI_AGAIN` covers transient DNS in agentless intake. `ENOTFOUND` is
// excluded because it usually means a misconfigured host, not a transient state.
const RETRIABLE_NETWORK_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOENT',
  'EPIPE',
  'ETIMEDOUT',
])

const startedAtMs = Date.now()
const reachedEndpoints = new Set()

/**
 * @typedef {object} EndpointOptions
 * @property {string} [socketPath]
 * @property {string} [hostname]
 * @property {string} [host]
 * @property {string|number} [port]
 */

/**
 * @param {Error & { code?: string }} error
 */
function isRetriableNetworkError (error) {
  return error?.code !== undefined && RETRIABLE_NETWORK_CODES.has(error.code)
}

function singleJitteredDelay () {
  return SINGLE_RETRY_BASE_MS + Math.random() * SINGLE_RETRY_JITTER_MS
}

/**
 * Stable key identifying the destination so the startup-phase gate is scoped
 * per endpoint. UDS path beats host:port because both can coexist on the same
 * options object after `parseUrl` runs.
 *
 * @param {EndpointOptions} options
 */
function getEndpointKey (options) {
  if (options.socketPath) return options.socketPath
  return `${options.hostname || options.host || ''}:${options.port || ''}`
}

/**
 * @param {EndpointOptions} options
 */
function inStartupPhase (options) {
  if ((Date.now() - startedAtMs) >= STARTUP_GRACE_MS) return false
  return !reachedEndpoints.has(getEndpointKey(options))
}

/**
 * Wait time before the next attempt when the previous one just failed. Bounded
 * exponential backoff with small jitter inside the startup grace window;
 * single 5–7.5 s jittered retry afterwards.
 *
 * @param {EndpointOptions} options
 * @param {number} previousAttempt 1-based index of the attempt that just failed.
 */
function getRetryDelay (options, previousAttempt) {
  if (!inStartupPhase(options)) return singleJitteredDelay()
  const exp = Math.min(STARTUP_BACKOFF_MAX_MS, STARTUP_BACKOFF_BASE_MS << (previousAttempt - 1))
  return exp + Math.random() * STARTUP_BACKOFF_JITTER_MS
}

/**
 * @param {EndpointOptions} options
 */
function getMaxAttempts (options) {
  return inStartupPhase(options) ? STARTUP_MAX_ATTEMPTS : POST_STARTUP_MAX_ATTEMPTS
}

/**
 * @param {EndpointOptions} options
 */
function markEndpointReached (options) {
  reachedEndpoints.add(getEndpointKey(options))
}

module.exports = {
  RATE_LIMIT_MAX_WAIT_MS,
  getMaxAttempts,
  getRetryDelay,
  isRetriableNetworkError,
  markEndpointReached,
  singleJitteredDelay,
}
