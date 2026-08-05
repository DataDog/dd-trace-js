'use strict'

const os = require('node:os')

/**
 * @param {import('../config/config-base')} config
 * @returns {import('@opentelemetry/api').Attributes}
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

module.exports = buildResourceAttributes
