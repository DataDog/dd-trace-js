'use strict'

const { version: tracerVersion } = require('../../../../../package.json')
const { buildCacheKey } = require('../requests/fs-cache')
const getConfig = require('../../config')

/**
 * Builds the cross-process filesystem cache key for the settings request from the
 * request configuration. The key also isolates the tracer version and local flags
 * applied while parsing the response.
 *
 * @param {object} configuration - Request configuration for the settings endpoint.
 * @returns {string}
 */
function buildSettingsCacheKey (configuration) {
  const config = getConfig()
  const { testOptimization } = config
  return buildCacheKey('settings', [
    tracerVersion,
    configuration.url?.href,
    configuration.isEvpProxy,
    configuration.evpProxyPrefix,
    configuration.sha,
    configuration.service,
    configuration.env,
    configuration.repositoryUrl,
    configuration.branch,
    configuration.tag,
    configuration.testLevel,
    configuration.osPlatform,
    configuration.osVersion,
    configuration.osArchitecture,
    configuration.runtimeName,
    configuration.runtimeVersion,
    configuration.custom,
    testOptimization.DD_CIVISIBILITY_DANGEROUSLY_FORCE_COVERAGE,
    testOptimization.DD_CIVISIBILITY_DANGEROUSLY_FORCE_TEST_SKIPPING,
    testOptimization.DD_CIVISIBILITY_CODE_COVERAGE_REPORT_UPLOAD_ENABLED,
  ])
}

module.exports = buildSettingsCacheKey
