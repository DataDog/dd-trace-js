'use strict'

let providerCreated = false

function markTracerProviderCreated () {
  providerCreated = true
}

function hasTracerProvider () {
  return providerCreated
}

module.exports = { markTracerProviderCreated, hasTracerProvider }
