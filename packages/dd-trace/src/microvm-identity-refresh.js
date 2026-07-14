'use strict'

const { channel } = require('dc-polyfill')

const updateChannel = channel('datadog:identity:update')

updateChannel.subscribe(refreshIdentity)

/**
 * Regenerates all MicroVM-clone-specific identities (id.js's batch entropy,
 * runtime ID, RC client ID) in response to a `datadog:identity:update` publish,
 * then publishes `datadog:identity:refresh` so subsystems that cache those
 * values (rather than reading `config` live) can react.
 *
 * @param {import('./config/config-base')} config
 */
function refreshIdentity (config) {
  require('./id').reseed()
  require('./config').refreshRuntimeId(config)
  require('./remote_config').refreshClientId(config)
  channel('datadog:identity:refresh').publish(config)
}
