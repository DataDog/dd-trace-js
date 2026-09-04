'use strict'

const { isIPv6 } = require('node:net')

let defaultAgentKey
let getProxyForUrl
let proxyAgents

/**
 * Selects a proxy agent for an HTTPS target while preserving the direct agent's pool boundaries.
 *
 * @param {string|URL|object} url
 * @param {import('node:http').Agent|false} [directAgent]
 * @returns {import('node:http').Agent|false|undefined}
 */
function getHttpsProxyAgent (url, directAgent) {
  getProxyForUrl ??= require('../../../../../vendor/dist/proxy-from-env').getProxyForUrl

  const host = typeof url === 'string' ? undefined : url.host ?? url.hostname
  const isUnbracketedIPv6 = typeof host === 'string' && host.includes(':') && isIPv6(host)
  const target = typeof url === 'string'
    ? url
    : { protocol: url.protocol, host: isUnbracketedIPv6 ? `[${host}]` : host, port: url.port }
  const proxyUrl = getProxyForUrl(target)
  if (!proxyUrl) return directAgent

  if (proxyAgents === undefined) {
    defaultAgentKey = {}
    proxyAgents = new WeakMap()
  }
  const cacheKey = directAgent || defaultAgentKey
  let agents = proxyAgents.get(cacheKey)
  if (agents === undefined) {
    agents = new Map()
    proxyAgents.set(cacheKey, agents)
  }

  let agent = agents.get(proxyUrl)
  if (agent === undefined) {
    const { HttpsProxyAgent } = require('../../../../../vendor/dist/https-proxy-agent')
    const options = directAgent
      ? { keepAlive: directAgent.keepAlive, maxSockets: directAgent.maxSockets }
      : undefined
    agent = new HttpsProxyAgent(proxyUrl, options)
    agents.set(proxyUrl, agent)
  }
  return agent
}

module.exports = { getHttpsProxyAgent }
