'use strict'

const log = require('../log')

/**
 * Checks if OpenTelemetry API peer dependency is available.
 * Note: \@opentelemetry/core and \@opentelemetry/resources are vendored (bundled),
 * so they are not checked as peer dependencies.
 * @returns {boolean} True if dependency is available, false otherwise
 */
function checkOpenTelemetryAPIDeps () {
  try {
    require.resolve('@opentelemetry/api')
  } catch {
    log.warn('Failed to resolve @opentelemetry/api. Install it with: npm install @opentelemetry/api')
    return false
  }
  return true
}

/**
 * Checks if OpenTelemetry API Logs peer dependency is available.
 * @returns {boolean} True if dependencies are available, false otherwise
 */
function checkOpenTelemetryLogsApiDeps () {
  let available = checkOpenTelemetryAPIDeps()
  try {
    require.resolve('@opentelemetry/api-logs')
  } catch {
    log.warn('Failed to resolve @opentelemetry/api-logs. Install it with: npm install @opentelemetry/api-logs')
    available = false
  }
  return available
}

module.exports = {
  checkOpenTelemetryAPIDeps,
  checkOpenTelemetryLogsApiDeps,
}
