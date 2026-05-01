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
let endpointReached = false

/**
 * @param {Error & { code?: string }} error
 */
function isRetriableNetworkError (error) {
  return error?.code !== undefined && RETRIABLE_NETWORK_CODES.has(error.code)
}

function singleJitteredDelay () {
  return SINGLE_RETRY_BASE_MS + Math.random() * SINGLE_RETRY_JITTER_MS
}

function inStartupPhase () {
  return !endpointReached && (Date.now() - startedAtMs) < STARTUP_GRACE_MS
}

/**
 * Wait time before the next attempt when the previous one just failed. Bounded
 * exponential backoff with small jitter inside the startup grace window;
 * single 5–7.5 s jittered retry afterwards.
 *
 * @param {number} previousAttempt 1-based index of the attempt that just failed.
 */
function getRetryDelay (previousAttempt) {
  if (!inStartupPhase()) return singleJitteredDelay()
  const exp = Math.min(STARTUP_BACKOFF_MAX_MS, STARTUP_BACKOFF_BASE_MS << (previousAttempt - 1))
  return exp + Math.random() * STARTUP_BACKOFF_JITTER_MS
}

function getMaxAttempts () {
  return inStartupPhase() ? STARTUP_MAX_ATTEMPTS : POST_STARTUP_MAX_ATTEMPTS
}

function markEndpointReached () {
  endpointReached = true
}

module.exports = {
  RATE_LIMIT_MAX_WAIT_MS,
  getMaxAttempts,
  getRetryDelay,
  isRetriableNetworkError,
  markEndpointReached,
  singleJitteredDelay,
}
