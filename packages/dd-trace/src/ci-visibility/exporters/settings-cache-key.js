'use strict'

const { createHmac } = require('node:crypto')

const { version: tracerVersion } = require('../../../../../package.json')
const { buildCacheKey } = require('../requests/fs-cache')
const getConfig = require('../../config')

/**
 * Derives a non-secret namespace for the direct API account. EVP requests are
 * already scoped by their agent origin and proxy path.
 *
 * @param {object} configuration - Request configuration for the settings endpoint.
 * @param {string|undefined} apiKey - Direct API credential.
 * @returns {string|undefined}
 */
function getBackendAccountCacheNamespace (configuration, apiKey) {
  if (configuration.isEvpProxy || apiKey === undefined) return

  return createHmac('sha256', apiKey)
    .update('dd-trace-js:test-optimization-settings-cache')
    .digest('hex')
}

/**
 * Builds the cross-process filesystem cache key for the settings request from the
 * request configuration. The key also isolates the backend account, tracer
 * version, and local flags applied while parsing the response.
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
    getBackendAccountCacheNamespace(configuration, config.DD_API_KEY),
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
