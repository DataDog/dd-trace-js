'use strict'

const maxExtraServices = 64
const extraServices = new Set()

process.env.DD_EXTRA_SERVICES?.split(',')
  .map(serviceName => serviceName.trim())
  .forEach(registerService)

function getExtraServices () {
  return [...extraServices]
}

function registerService (serviceName) {
  if (serviceName && extraServices.size < maxExtraServices) {
    extraServices.add(serviceName)
  }
}

function clear () {
  extraServices.clear()
}

module.exports = {
  registerService,
  getExtraServices,
  clear
}
