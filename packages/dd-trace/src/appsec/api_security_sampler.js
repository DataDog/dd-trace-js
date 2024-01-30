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
