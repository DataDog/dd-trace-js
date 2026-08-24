'use strict'

const http = require('node:http')
const https = require('node:https')

const { createAgent } = require('../../exporters/common/agents')

// The bounded final flush must not spend its deadline serializing same-origin payload requests behind one socket.
const options = { keepAlive: true, maxSockets: 8 }
const httpAgent = createAgent(http.Agent, options)
const httpsAgent = createAgent(https.Agent, options)

/**
 * Selects the dedicated Test Optimization agent for an intake URL.
 *
 * @param {string|URL|object} url
 * @returns {http.Agent|https.Agent}
 */
function getAgent (url) {
  const isSecure = typeof url === 'string' ? url.startsWith('https:') : url?.protocol === 'https:'
  return isSecure ? httpsAgent : httpAgent
}

module.exports = { getAgent, httpAgent, httpsAgent }
