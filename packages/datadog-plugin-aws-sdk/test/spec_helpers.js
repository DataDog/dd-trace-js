'use strict'

const { minVersion } = require('semver')

const externals = require('../../dd-trace/test/plugins/externals')
const { getInstrumentation } = require('../../dd-trace/test/setup/helpers/load-inst')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { NODE_MAJOR } = require('../../../version')

const sort = spans => spans.sort((a, b) => a.start.toString() >= b.start.toString() ? 1 : -1)

/**
 * @param {object} client AWS client (v2 service instance or v3 aggregated client).
 * @param {string} method Operation name, e.g. `getRecords` or `sendMessage`.
 * @param {object} params Operation parameters.
 * @returns {Promise<object>} Resolves with the operation result.
 */
function callViaCallback (client, method, params) {
  return new Promise((resolve, reject) => {
    const operation = client[method](params, (error, result) => {
      if (error) {
        reject(error)
      } else {
        resolve(result)
      }
    })
    Promise.resolve(operation).catch(reject)
  })
}

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
 */
function withAwsSdkV2Versions (range, cb) {
  if (typeof range === 'function') {
    cb = range
    range = '*'
  }

  withVersions('aws-sdk', ['aws-sdk'], range, cb)
}

/**
 * @param {string} moduleName
 * @param {string|AwsSdkVersionCallback} range
 * @param {AwsSdkVersionCallback} [cb]
 */
function withAwsSdkV3Versions (moduleName, range, cb) {
  if (typeof range === 'function') {
    cb = range
    range = '*'
  }

  withVersions('aws-sdk', moduleName, getAwsSdkV3Range(moduleName, range), cb)
}

/**
 * @param {string} moduleName
 * @param {string|AwsSdkVersionCallback} range
 * @param {AwsSdkVersionCallback} [cb]
 */
function withAwsSdkVersions (moduleName, range, cb) {
  if (typeof range === 'function') {
    cb = range
    range = '*'
  }

  withAwsSdkV2Versions(range, cb)
  withAwsSdkV3Versions(moduleName, range, cb)
}

/**
 * @param {string} moduleName
 * @param {string} range
 */
function getAwsSdkV3Range (moduleName, range) {
  if (NODE_MAJOR !== 18) return range

  const declarations = [...getInstrumentation('aws-sdk'), ...externals['aws-sdk']]
    .filter(declaration => declaration.name === moduleName)
  const supported = minVersion(declarations.flatMap(declaration => declaration.versions).join(' || ')).version
  return range === '*' ? supported : `${range} ${supported}`
}

const helpers = {
  callViaCallback,
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
