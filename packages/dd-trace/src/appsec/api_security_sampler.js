'use strict'

const log = require('../log')

let enabled
let requestSampling

function configure ({ apiSecurity }) {
  enabled = apiSecurity.enabled
  setRequestSampling(apiSecurity.requestSampling)
}

function disable () {
  enabled = false
}

function setRequestSampling (sampling) {
  requestSampling = parseRequestSampling(sampling)
}

function parseRequestSampling (requestSampling) {
  const parsed = parseFloat(requestSampling)

  if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
    return parsed
  } else {
    log.warn(`Incorrect API Security request sampling value: ${requestSampling}`)

    // NOTE: 0 or 0.1 the default value?
    return 0
  }
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
  setRequestSampling,
  sampleRequest
}
