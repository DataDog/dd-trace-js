'use strict'

const aws = require('./aws.json')
const sdks = { aws }

/**
 * Builds rules per service for a given SDK, appending user-provided rules.
 *
 * @param {Record<string, { request: string[], response: string[], expand: string[] }>} sdk
 * @param {string[]} requestInput
 * @param {string[]} responseInput
 * @returns {Record<string, { request: string[], response: string[], expand: string[] }>}
 */
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

/**
 * Appends input rules to all supported SDKs and returns a structure mapping SDK
 * names to per-service rules.
 *
 * @param {string[]} [requestInput=[]]
 * @param {string[]} [responseInput=[]]
 * @returns {Record<string, Record<string, { request: string[], response: string[], expand: string[] }>>}
 */
function appendRules (requestInput = [], responseInput = []) {
  const sdkRules = {}
  for (const [name, sdk] of Object.entries(sdks)) {
    sdkRules[name] = getSDKRules(sdk, requestInput, responseInput)
  }
  return sdkRules
}

module.exports = { appendRules }
