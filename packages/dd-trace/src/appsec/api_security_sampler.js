'use strict'

const log = require('../log')

let requestSampling

function configure ({ apiSecurity }) {
  setRequestSampling(apiSecurity.requestSampling)
}

function setRequestSampling (sampling) {
  requestSampling = parseRequestSampling(sampling)
}

function parseRequestSampling (requestSampling) {
  let parsed = parseFloat(requestSampling)

  if (isNaN(parsed)) {
    log.warn(`Incorrect API Security request sampling value: ${requestSampling}`)

    parsed = 0
  } else {
    parsed = Math.min(1, Math.max(0, parsed))
  }

  return parsed
}

function sampleRequest () {
  if (!requestSampling) {
    return false
  }

  return Math.random() <= requestSampling
}

module.exports = {
  configure,
  setRequestSampling,
  sampleRequest
}
