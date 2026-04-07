'use strict'

const { getEnvironmentVariable } = require('../config/helper')
const { isTrue } = require('../util')

/**
 * Returns the current Lage package name if the Lage package name override is enabled.
 *
 * @returns {string|undefined}
 */
function getLagePackageName () {
  if (!isTrue(getEnvironmentVariable('DD_ENABLE_LAGE_PACKAGE_NAME'))) {
    return
  }

  const packageName = getEnvironmentVariable('LAGE_PACKAGE_NAME')
  if (!packageName) {
    return
  }

  return packageName
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
  getLageTestSessionName,
}
