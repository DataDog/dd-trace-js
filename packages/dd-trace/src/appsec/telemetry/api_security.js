'use strict'

const telemetryMetrics = require('../../telemetry/metrics')

const appsecMetrics = telemetryMetrics.manager.namespace('appsec')

const normalizedFrameworkCache = new Map()

function normalizeFramework (framework) {
  let normalized = normalizedFrameworkCache.get(framework)
  if (normalized === undefined) {
    normalized = framework ? framework.toLowerCase().replaceAll(' ', '_') : ''
    normalizedFrameworkCache.set(framework, normalized)
  }
  return normalized
}

function incrementApiSecRequestSchema (framework) {
  appsecMetrics.count('api_security.request.schema', { framework: normalizeFramework(framework) }).inc()
}

function incrementApiSecRequestNoSchema (framework) {
  appsecMetrics.count('api_security.request.no_schema', { framework: normalizeFramework(framework) }).inc()
}

function incrementApiSecMissingRoute (framework) {
  appsecMetrics.count('api_security.missing_route', { framework: normalizeFramework(framework) }).inc()
}

module.exports = {
  incrementApiSecRequestSchema,
  incrementApiSecRequestNoSchema,
  incrementApiSecMissingRoute,
}
