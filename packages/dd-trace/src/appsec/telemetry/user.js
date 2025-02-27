'use strict'

const telemetryMetrics = require('../../telemetry/metrics')

const appsecMetrics = telemetryMetrics.manager.namespace('appsec')

function incrementMissingUserLogin (framework, eventType) {
  appsecMetrics.count('instrum.user_auth.missing_user_login', {
    framework,
    event_type: eventType
  }).inc()
}

function incrementMissingUserId (framework, eventType) {
  appsecMetrics.count('instrum.user_auth.missing_user_id', {
    framework,
    event_type: eventType
  }).inc()
}

module.exports = {
  incrementMissingUserLogin,
  incrementMissingUserId
}
