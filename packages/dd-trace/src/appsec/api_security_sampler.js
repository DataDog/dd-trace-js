'use strict'

let enabled
let requestSampling

function configure (apiSecurityConfig) {
  enabled = apiSecurityConfig.enabled
  requestSampling = apiSecurityConfig.requestSampling
}

function disable () {
  enabled = false
}

function sampleRequest () {
  if (!enabled || !requestSampling) {
    return false
  }

  return Math.random() <= requestSampling
}

module.exports = {
  configure,
  disable,
  sampleRequest
}
