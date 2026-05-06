'use strict'

const aws = require('./aws.json')
const sdks = { aws }

/** @typedef {Record<string, { request: string[], response: string[], expand: string[] }>} SDKRules */
/**
 * Builds rules per service for a given SDK, appending user-provided rules.
 *
 * @param {SDKRules} sdk
 * @param {string[]} requestInput
 * @param {string[]} responseInput
 * @returns {SDKRules}
 */
function getSDKRules (sdk, requestInput, responseInput) {
  const sdkServiceRules = /** @type {SDKRules} */ ({})
  for (const [service, serviceRules] of Object.entries(sdk)) {
    sdkServiceRules[service] = {
      // Make a copy. Otherwise calling the function multiple times would append
      // the rules to the same object.
      request: [...serviceRules.request, ...requestInput],
      response: [...serviceRules.response, ...responseInput],
      expand: serviceRules.expand,
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
 * @returns {Record<string, SDKRules>}
 */
function appendRules (requestInput = [], responseInput = []) {
  const sdkRules = /** @type {Record<string, SDKRules>} */ ({})
  for (const [name, sdk] of Object.entries(sdks)) {
    sdkRules[name] = getSDKRules(sdk, requestInput, responseInput)
  }
  return sdkRules
}

module.exports = { appendRules }
