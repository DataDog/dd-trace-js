'use strict'

const log = require('../log')

/**
 * Checks if OpenTelemetry Core and Resources peer dependencies are available.
 * @returns {boolean} True if dependencies are available, false otherwise
 */
function checkOpenTelemetryHelpers () {
  let available = true
  try {
    require.resolve('@opentelemetry/core')
  } catch {
    log.warn('Failed to resolve @opentelemetry/core. Install it with: npm install @opentelemetry/core')
    available = false
  }
  try {
    require.resolve('@opentelemetry/resources')
  } catch {
    log.warn('Failed to resolve @opentelemetry/resources. Install it with: npm install @opentelemetry/resources')
    available = false
  }
  return available
}

/**
 * Checks if OpenTelemetry peer dependencies are available.
 * @returns {boolean} True if dependencies are available, false otherwise
 */
function checkOpenTelemetryAPIDeps () {
  try {
    require.resolve('@opentelemetry/api')
  } catch {
    log.warn('Failed to resolve @opentelemetry/api. Install it with: npm install @opentelemetry/api')
    checkOpenTelemetryHelpers()
    return false
  }
  return checkOpenTelemetryHelpers()
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
  checkOpenTelemetryLogsApiDeps
}
