'use strict'

const maxExtraServices = 64
/** @type {Set<string>} */
const extraServices = new Set()

// 1-element cache of the most-recent argument. The sole production caller
// (`span_format.js`) runs per span; without the cache every redis / mysql
// burst pays a `Set.add` hash + probe even though the value is already
// registered.
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
