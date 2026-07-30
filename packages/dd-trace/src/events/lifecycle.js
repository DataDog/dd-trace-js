'use strict'

const dc = require('dc-polyfill')

/**
 * Create the diagnostic channels for one semantic operation lifecycle.
 *
 * @param {string} prefix Semantic operation channel prefix.
 * @param {string[]} phases Lifecycle phases supported by the operation.
 * @returns {Record<string, import('diagnostics_channel').Channel>} Channels keyed by phase.
 */
function createLifecycleChannels (prefix, phases) {
  const channels = {}

  for (const phase of phases) {
    channels[phase] = dc.channel(`${prefix}:${phase}`)
  }

  return channels
}

module.exports = { createLifecycleChannels }
