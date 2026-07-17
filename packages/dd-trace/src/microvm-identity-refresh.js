'use strict'

const { channel } = require('dc-polyfill')

const updateChannel = channel('datadog:identity:update')

updateChannel.subscribe(refreshIdentity)

/**
 * Regenerates all MicroVM-clone-specific identities (id.js's batch entropy,
 * runtime ID, RC client ID) in response to a `datadog:identity:update` publish.
 *
 * @param {import('./config/config-base')} config
 */
function refreshIdentity (config) {
  require('./id').reseed()
  require('./config').refreshRuntimeId(config)
  require('./remote_config').refreshClientId(config)
}
