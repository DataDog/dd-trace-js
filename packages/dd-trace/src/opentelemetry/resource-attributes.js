'use strict'

const os = require('node:os')

const { channel } = require('dc-polyfill')

const identityRefreshChannel = channel('datadog:identity:refresh')
const resourceAttributeRefreshers = new Map()

function refreshActiveResourceAttributes () {
  for (const refreshResourceAttributes of resourceAttributeRefreshers.values()) {
    refreshResourceAttributes()
  }
}

/**
 * @typedef {import('@opentelemetry/api').Attributes} Attributes
 * @typedef {{
 *   signalType: string,
 *   updateResourceAttributes: (resourceAttributes: Attributes) => void
 * }} ResourceAttributeExporter
 */

/**
 * @param {import('../config/config-base')} config
 * @returns {Attributes}
 */
function buildResourceAttributes (config) {
  const { service, version, env, ...tags } = config.tags
  const resourceAttributes = {
    'service.name': config.service,
    'service.version': config.version,
    'deployment.environment': config.env,
    ...tags,
  }

  if (config.reportHostname) resourceAttributes['host.name'] = os.hostname()

  return resourceAttributes
}

/**
 * @param {ResourceAttributeExporter} exporter
 * @param {() => Attributes} buildResourceAttributes
 */
function registerResourceAttributeRefresh (exporter, buildResourceAttributes) {
  if (resourceAttributeRefreshers.size === 0) {
    identityRefreshChannel.subscribe(refreshActiveResourceAttributes)
  }
  resourceAttributeRefreshers.set(exporter.signalType, () => {
    exporter.updateResourceAttributes(buildResourceAttributes())
  })
}

module.exports = { buildResourceAttributes, registerResourceAttributeRefresh }
