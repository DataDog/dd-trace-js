'use strict'

const http = require('node:http')
const https = require('node:https')

const createAgentClass = require('../../exporters/common/create-agent-class')

const maxSockets = 8
const HttpAgent = createAgentClass(http.Agent, maxSockets)
const HttpsAgent = createAgentClass(https.Agent, maxSockets)

const httpAgent = new HttpAgent()
const httpsAgent = new HttpsAgent()

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

module.exports = { getAgent }
