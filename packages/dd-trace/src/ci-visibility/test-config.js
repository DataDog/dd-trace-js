'use strict'

const configMap = require('../../test/config-map')

function effectiveConfig (span) {
  const finalConfig = span.context()._config

  // Spans created before this change might not have a config.
  if (!finalConfig) return {}

  const testConfig = {}

  for (const key in configMap) {
    const { env, defaultValue } = configMap[key]
    const value = finalConfig[key]
    const valuesAreNotEqual = JSON.stringify(value) !== JSON.stringify(defaultValue)
    if (env && value !== undefined && value !== defaultValue && valuesAreNotEqual) {
      testConfig[env] = value
    }
  }
  return testConfig
}

function getTestConfig () {
  return {
    effectiveConfig
  }
}

module.exports = getTestConfig
