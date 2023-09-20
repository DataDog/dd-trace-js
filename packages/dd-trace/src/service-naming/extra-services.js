'use strict'

const maxExtraServices = 64
const extraServices = new Set()

function getExtraServices () {
  return [...extraServices]
}

function registerExtraService (serviceName) {
  if (serviceName && !extraServices.has(serviceName) && extraServices.size < maxExtraServices) {
    extraServices.add(serviceName)
    return true
  }
  return false
}

function clear () {
  extraServices.clear()
}

module.exports = {
  registerExtraService,
  getExtraServices,
  clear
}
