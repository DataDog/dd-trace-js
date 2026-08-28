'use strict'

const http = require('http')
const https = require('https')

const { createAgents } = require('../../exporters/common/agents')

// Finalization can flush several Test Optimization payload types together. A dedicated pool keeps
// that burst from queuing behind the shared exporters' single socket while preserving a hard cap.
const maxSockets = 16

const { httpAgent, httpsAgent } = createAgents(maxSockets)

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

  try {
    return new URL(url).protocol === 'https:' ? httpsAgent : httpAgent
  } catch {
    return String(url).startsWith('https:') ? httpsAgent : httpAgent
  }
}

module.exports = { getAgent }
