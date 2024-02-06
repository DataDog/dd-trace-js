'use strict'

const log = require('../log')

let enabled
let requestSampling

const sampledRequests = new WeakSet()

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

function sampleRequest (req) {
  if (!enabled || !requestSampling) {
    return false
  }

  const shouldSample = Math.random() <= requestSampling

  if (shouldSample) {
    sampledRequests.add(req)
  }

  return shouldSample
}

function isSampled (req) {
  return sampledRequests.has(req)
}

module.exports = {
  configure,
  disable,
  setRequestSampling,
  sampleRequest,
  isSampled
}
