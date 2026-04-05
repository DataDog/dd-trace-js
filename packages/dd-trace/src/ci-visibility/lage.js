'use strict'

const { getEnvironmentVariable } = require('../config/helper')
const { isTrue } = require('../util')

const LAGE_PACKAGE_CONFIGURATION_TAG = 'lage_package_name'
const LAGE_PACKAGE_CONFIGURATION_EVENT_TAG = 'test.configuration.lage_package_name'

/**
 * Returns the current Lage package name if package-based test optimization is enabled.
 *
 * @returns {string|undefined}
 */
function getLagePackageName () {
  if (!isTrue(getEnvironmentVariable('DD_CIVISIBILITY_USE_LAGE_PACKAGE_NAME'))) {
    return
  }

  const packageName = getEnvironmentVariable('LAGE_PACKAGE_NAME')
  if (!packageName) {
    return
  }

  return packageName
}

/**
 * Returns the late-bound test optimization configuration derived from the current Lage package.
 *
 * @returns {Record<string, string>}
 */
function getLagePackageConfigurationTags () {
  const packageName = getLagePackageName()
  if (!packageName) {
    return {}
  }

  return {
    [LAGE_PACKAGE_CONFIGURATION_TAG]: packageName,
  }
}

/**
 * Returns the current Lage package as a test configuration event tag.
 *
 * @returns {Record<string, string>}
 */
function getLagePackageConfigurationEventTags () {
  const packageName = getLagePackageName()
  if (!packageName) {
    return {}
  }

  return {
    [LAGE_PACKAGE_CONFIGURATION_EVENT_TAG]: packageName,
  }
}

/**
 * Returns the current Lage package name as the test session name unless the user set one explicitly.
 *
 * @returns {string|undefined}
 */
function getLageTestSessionName () {
  if (getEnvironmentVariable('DD_TEST_SESSION_NAME')) {
    return
  }

  return getLagePackageName()
}

module.exports = {
  getLagePackageConfigurationEventTags,
  getLagePackageConfigurationTags,
  getLageTestSessionName,
}
