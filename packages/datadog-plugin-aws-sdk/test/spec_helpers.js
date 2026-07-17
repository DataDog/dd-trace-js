'use strict'

const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { NODE_MAJOR } = require('../../../version')

const AWS_SDK_V3_RANGE = NODE_MAJOR === 18 ? '3.0.0' : '>3.0.0'

const sort = spans => spans.sort((a, b) => a.start.toString() >= b.start.toString() ? 1 : -1)

/**
 * @param {object} client AWS client (v2 service instance or v3 aggregated client).
 * @param {string} method Operation name, e.g. `getRecords` or `sendMessage`.
 * @param {object} params Operation parameters.
 * @returns {Promise<object>} Resolves with the operation result.
 */
function callViaPromise (client, method, params) {
  const result = client[method](params)
  // v2 returns an AWS.Request exposing `.promise()`; v3's aggregated client returns a Promise directly.
  return typeof result.promise === 'function' ? result.promise() : result
}

/**
 * @callback AwsSdkVersionCallback
 * @param {string} version
 * @param {string} moduleName
 * @param {string} resolvedVersion
 * @returns {void}
 */

/**
 * @param {string|AwsSdkVersionCallback} range
 * @param {AwsSdkVersionCallback} [cb]
 * @returns {void}
 */
function withAwsSdkV2Versions (range, cb) {
  if (typeof range === 'function') {
    cb = range
    range = '*'
  }

  withVersions('aws-sdk', ['aws-sdk'], range, cb)
}

/**
 * @param {string|AwsSdkVersionCallback} range
 * @param {AwsSdkVersionCallback} [cb]
 * @returns {void}
 */
function withAwsSdkV3Versions (range, cb) {
  if (typeof range === 'function') {
    cb = range
    range = '*'
  }

  withVersions('aws-sdk', ['@aws-sdk/smithy-client'], getAwsSdkV3Range(range), cb)
}

/**
 * @param {string|AwsSdkVersionCallback} range
 * @param {AwsSdkVersionCallback} [cb]
 * @returns {void}
 */
function withAwsSdkVersions (range, cb) {
  if (typeof range === 'function') {
    cb = range
    range = '*'
  }

  withAwsSdkV2Versions(range, cb)
  withAwsSdkV3Versions(range, cb)
}

/**
 * @param {string} range
 * @returns {string}
 */
function getAwsSdkV3Range (range) {
  return range === '*' ? AWS_SDK_V3_RANGE : `${range} ${AWS_SDK_V3_RANGE}`
}

const helpers = {
  callViaPromise,
  sort,
  withAwsSdkV2Versions,
  withAwsSdkV3Versions,
  withAwsSdkVersions,

  setup () {
    before(() => {
      process.env.AWS_SECRET_ACCESS_KEY = '0000000000/00000000000000000000000000000'
      process.env.AWS_ACCESS_KEY_ID = '00000000000000000000'
      process.env.DD_DATA_STREAMS_ENABLED = 'true'
    })

    after(() => {
      delete process.env.AWS_SECRET_ACCESS_KEY
      delete process.env.AWS_ACCESS_KEY_ID
      delete process.env.DD_DATA_STREAMS_ENABLED
    })
  },
}

module.exports = helpers
