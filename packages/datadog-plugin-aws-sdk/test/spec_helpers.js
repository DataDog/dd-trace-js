'use strict'

const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { NODE_MAJOR } = require('../../../version')

const AWS_SDK_V2_RANGE = NODE_MAJOR === 18 ? '<2.1693.0' : '*'
const AWS_SDK_V3_RANGE = NODE_MAJOR === 18 ? '3.0.0' : '>3.0.0'

const sort = spans => spans.sort((a, b) => a.start.toString() >= b.start.toString() ? 1 : -1)

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
    range = undefined
  }

  withVersions('aws-sdk', ['aws-sdk'], getAwsSdkV2Range(range), cb)
}

/**
 * @param {string|AwsSdkVersionCallback} range
 * @param {AwsSdkVersionCallback} [cb]
 * @returns {void}
 */
function withAwsSdkV3Versions (range, cb) {
  if (typeof range === 'function') {
    cb = range
    range = undefined
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
    range = undefined
  }

  withAwsSdkV2Versions(range, cb)
  withAwsSdkV3Versions(range, cb)
}

/**
 * @param {string|undefined} range
 * @returns {string}
 */
function getAwsSdkV2Range (range) {
  return range === undefined ? AWS_SDK_V2_RANGE : `${range} ${AWS_SDK_V2_RANGE}`
}

/**
 * @param {string|undefined} range
 * @returns {string}
 */
function getAwsSdkV3Range (range) {
  return range === undefined ? AWS_SDK_V3_RANGE : `${range} ${AWS_SDK_V3_RANGE}`
}

const helpers = {
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
