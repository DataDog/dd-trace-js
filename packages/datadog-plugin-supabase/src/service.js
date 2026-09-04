'use strict'

/**
 * @param {string | undefined} pluginService Configured integration service.
 * @param {string} tracerService Default tracer service.
 * @returns {{ name: string, source?: string }} Resolved service name and source.
 */
function getService (pluginService, tracerService) {
  return pluginService
    ? { name: pluginService, source: 'opt.plugin' }
    : { name: tracerService }
}

module.exports = getService
