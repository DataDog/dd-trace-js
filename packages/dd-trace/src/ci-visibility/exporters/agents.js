'use strict'

const http = require('http')
const https = require('https')

const { createAgents } = require('../../exporters/common/agents')

// Finalization can flush several Test Optimization payload types together. Keep media on a separate
// bounded pool so long uploads cannot consume the sockets needed by trace, coverage, and log writers.
const maxSockets = 16

const payloadAgents = createAgents(maxSockets)
const mediaAgents = createAgents(maxSockets)

/**
 * Selects an agent by intake URL protocol.
 *
 * @param {string|URL|object} url
 * @param {{httpAgent: http.Agent, httpsAgent: https.Agent}} agents
 * @returns {http.Agent|https.Agent}
 */
function selectAgent (url, { httpAgent, httpsAgent }) {
  const protocol = url?.protocol
  if (protocol === 'https:' || protocol === 'https') return httpsAgent
  if (protocol === 'http:' || protocol === 'http') return httpAgent

  try {
    return new URL(url).protocol === 'https:' ? httpsAgent : httpAgent
  } catch {
    return String(url).startsWith('https:') ? httpsAgent : httpAgent
  }
}

/**
 * Selects the dedicated Test Optimization payload agent for an intake URL.
 *
 * @param {string|URL|object} url
 * @returns {http.Agent|https.Agent}
 */
function getAgent (url) {
  return selectAgent(url, payloadAgents)
}

/**
 * Selects the isolated Test Optimization media agent for an intake URL.
 *
 * @param {string|URL|object} url
 * @returns {http.Agent|https.Agent}
 */
function getMediaAgent (url) {
  return selectAgent(url, mediaAgents)
}

module.exports = { getAgent, getMediaAgent }
