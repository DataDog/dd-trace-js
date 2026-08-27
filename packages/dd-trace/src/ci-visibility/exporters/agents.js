'use strict'

const http = require('node:http')
const https = require('node:https')

const { createAgentClass } = require('../../exporters/common/agents')

// Test Optimization flushes many payloads near process exit. The shared exporter
// agents cap at a single socket per origin, so concurrent payloads queue behind
// one connection and the bounded final flush aborts the backlog. A dedicated
// pool with bounded concurrency drains the queue in parallel instead.
const MAX_SOCKETS = 16
const HttpAgent = createAgentClass(http.Agent, MAX_SOCKETS)
const HttpsAgent = createAgentClass(https.Agent, MAX_SOCKETS)

const httpAgent = new HttpAgent()
const httpsAgent = new HttpsAgent()

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
  const protocol = url?.protocol
  if (protocol === 'https:' || protocol === 'https') return httpsAgent
  if (protocol === 'http:' || protocol === 'http') return httpAgent

  const parsed = toURL(url)
  const isSecure = parsed ? parsed.protocol === 'https:' : String(url).startsWith('https:')
  return isSecure ? httpsAgent : httpAgent
}

module.exports = { getAgent }
