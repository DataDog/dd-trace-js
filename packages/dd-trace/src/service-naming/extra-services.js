'use strict'

const maxExtraServices = 64
/** @type {Set<string>} */
const extraServices = new Set()

// 1-element cache of the most-recent argument. Designed for a per-span hot path
// (e.g. redis / mysql bursts that repeatedly register the same service); without
// the cache each call pays a `Set.add` hash + probe even when the value is
// already registered. The sole production caller is `span_format`, which runs
// per finished span on both pipelines and only calls in when the span's service
// actually differs from the tracer's own.
/** @type {string | null | undefined} */
let lastSeenService

function getExtraServices () {
  return [...extraServices]
}

/**
 * @param {string | null} [serviceName]
 */
function registerExtraService (serviceName) {
  if (serviceName === lastSeenService) return
  lastSeenService = serviceName
  if (serviceName && extraServices.size < maxExtraServices) {
    extraServices.add(serviceName)
  }
}

function clear () {
  extraServices.clear()
  lastSeenService = undefined
}

module.exports = {
  registerExtraService,
  getExtraServices,
  clear,
}
