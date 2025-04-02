'use strict'

const log = require('../../log')
const { getRootSpan } = require('./utils')
const { setUserTagsSdk } = require('./set_user')
const waf = require('../waf')
const { keepTrace } = require('../../priority_sampler')
const addresses = require('../addresses')
const { ASM } = require('../../standalone/product')
const { incrementSdkEventMetric } = require('../telemetry')
const telemetryMetrics = require('../../telemetry/metrics')

const appsecMetrics = telemetryMetrics.manager.namespace('appsec')

function increaseSdkEventMetric (eventType, version) {
  const tags = {
    event_type: eventType,
    sdk_version: version
  }

  appsecMetrics.count('sdk.event', tags).inc(1)
}

/**
 * @deprecated in favor of trackUserLoginSuccessV2
 */
function trackUserLoginSuccessEvent (tracer, user, metadata) {
  // TODO: better user check here and in _setUser() ?
  if (!user || !user.id) {
    log.warn('[ASM] Invalid user provided to trackUserLoginSuccessEvent')
    return
  }

  incrementSdkEventMetric('login_success')

  const rootSpan = getRootSpan(tracer)
  if (!rootSpan) {
    log.warn('[ASM] Root span not available in trackUserLoginSuccessEvent')
    return
  }

  setUserTagsSdk(user, rootSpan)

  const login = user.login ?? user.id

  metadata = { 'usr.login': login, ...metadata }

  trackEvent('users.login.success', metadata, 'trackUserLoginSuccessEvent', rootSpan)

  runWaf('users.login.success', { id: user.id, login })

  increaseSdkEventMetric('login_success', 'v1')
}

/**
 * @deprecated in favor of trackUserLoginFailureV2
 */
function trackUserLoginFailureEvent (tracer, userId, exists, metadata) {
  if (!userId || typeof userId !== 'string') {
    log.warn('[ASM] Invalid userId provided to trackUserLoginFailureEvent')
    return
  }

  const fields = {
    'usr.id': userId,
    'usr.login': userId,
    'usr.exists': exists ? 'true' : 'false',
    ...metadata
  }

  trackEvent('users.login.failure', fields, 'trackUserLoginFailureEvent', getRootSpan(tracer))

  runWaf('users.login.failure', { login: userId })

  incrementSdkEventMetric('login_failure')

  increaseSdkEventMetric('login_failure', 'v1')
}

function trackCustomEvent (tracer, eventName, metadata) {
  if (!eventName || typeof eventName !== 'string') {
    log.warn('[ASM] Invalid eventName provided to trackCustomEvent')
    return
  }

  trackEvent(eventName, metadata, 'trackCustomEvent', getRootSpan(tracer))

  incrementSdkEventMetric('custom')

  if (eventName === 'users.login.success' || eventName === 'users.login.failure') {
    runWaf(eventName)
  }

  increaseSdkEventMetric('custom', 'v1')
}

function trackUserLoginSuccessV2 (tracer, login, user, metadata) {
  if (!login || typeof login !== 'string') {
    log.warn('[ASM] Invalid login provided to v2.trackUserLoginSuccess')
    return
  }

  const rootSpan = getRootSpan(tracer)
  if (!rootSpan) {
    log.warn('[ASM] Root span not available in v2.trackUserLoginSuccess')
    return
  }

  const wafData = { login }

  metadata = {
    'usr.login': login,
    ...metadata
  }

  if (user) {
    if (typeof user !== 'object') {
      user = { id: user }
    }

    if (user.id) {
      wafData.id = user.id
      setUserTagsSdk(user, rootSpan)
      metadata.usr = user
    }
  }

  trackEvent('users.login.success', metadata, 'v2.trackUserLoginSuccess', rootSpan)

  runWaf('users.login.success', wafData)

  increaseSdkEventMetric('login_success', 'v2')
}

function trackUserLoginFailureV2 (tracer, login, exists, metadata) {
  if (!login || typeof login !== 'string') {
    log.warn('[ASM] Invalid login provided to v2.trackUserLoginFailure')
    return
  }

  const rootSpan = getRootSpan(tracer)
  if (!rootSpan) {
    log.warn('[ASM] Root span not available in v2.trackUserLoginFailure')
    return
  }

  const wafData = { login }

  if (typeof exists === 'object' && typeof metadata === 'undefined') {
    metadata = exists
    exists = false
  }

  metadata = {
    'usr.login': login,
    'usr.exists': exists ? 'true' : 'false',
    ...metadata
  }

  trackEvent('users.login.failure', metadata, 'v2.trackUserLoginFailure', rootSpan)

  runWaf('users.login.failure', wafData)

  increaseSdkEventMetric('login_failure', 'v2')
}

function flattenFields (fields, sdkMethodName, depth = 0) {
  if (depth > 4) {
    return {
      truncated: true
    }
  }

  const result = {}
  let truncated = false
  for (const key of Object.keys(fields)) {
    const value = fields[key]

    if (value && typeof value === 'object') {
      const { result: flatValue, truncated: inheritTruncated } = flattenFields(value, sdkMethodName, depth + 1)
      truncated = truncated || inheritTruncated

      if (flatValue) {
        for (const flatKey of Object.keys(flatValue)) {
          result[`${key}.${flatKey}`] = flatValue[flatKey]
        }
      }
    } else {
      if (value !== undefined) {
        result[key] = value
      }
    }
  }

  return { result, truncated }
}

function trackEvent (eventName, fields, sdkMethodName, rootSpan) {
  if (!rootSpan) {
    log.warn('[ASM] Root span not available in %s', sdkMethodName)
    return
  }

  const tags = {
    [`appsec.events.${eventName}.track`]: 'true',
    [`_dd.appsec.events.${eventName}.sdk`]: 'true'
  }

  if (fields) {
    const { result: flatFields, truncated } = flattenFields(fields, sdkMethodName)

    if (truncated) {
      log.warn('[ASM] Too deep object provided in the SDK method %s, object truncated', sdkMethodName)
    }

    for (const metadataKey of Object.keys(flatFields)) {
      tags[`appsec.events.${eventName}.${metadataKey}`] = '' + flatFields[metadataKey]
    }
  }

  rootSpan.addTags(tags)

  keepTrace(rootSpan, ASM)
}

function runWaf (eventName, user) {
  const persistent = {
    [`server.business_logic.${eventName}`]: null
  }

  if (user?.id) {
    persistent[addresses.USER_ID] = '' + user.id
  }

  if (user?.login) {
    persistent[addresses.USER_LOGIN] = '' + user.login
  }

  waf.run({ persistent })
}

module.exports = {
  trackUserLoginSuccessEvent,
  trackUserLoginSuccessV2,
  trackUserLoginFailureV2,
  trackUserLoginFailureEvent,
  trackCustomEvent,
  trackEvent,
  runWaf
}
