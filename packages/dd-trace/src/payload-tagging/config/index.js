'use strict'

const aws = require('./aws.json')
const sdks = { aws }

function getSDKRules (sdk, requestInput, responseInput) {
  const sdkServiceRules = {}
  for (const [service, serviceRules] of Object.entries(sdk)) {
    sdkServiceRules[service] = {
      // Make a copy. Otherwise calling the function multiple times would append
      // the rules to the same object.
      request: [...serviceRules.request, ...requestInput],
      response: [...serviceRules.response, ...responseInput],
      expand: serviceRules.expand
    }
  }
  return sdkServiceRules
}

function appendRules (requestInput = [], responseInput = []) {
  const sdkRules = {}
  for (const [name, sdk] of Object.entries(sdks)) {
    sdkRules[name] = getSDKRules(sdk, requestInput, responseInput)
  }
  return sdkRules
}

module.exports = { appendRules }
