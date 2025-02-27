'use strict'

const log = require('../../log')
const { getRootSpan } = require('./utils')
const { setUserTags } = require('./set_user')
const standalone = require('../standalone')
const waf = require('../waf')
const { SAMPLING_MECHANISM_APPSEC } = require('../../constants')
const { keepTrace } = require('../../priority_sampler')
const addresses = require('../addresses')
const telemetryMetrics = require('../../telemetry/metrics')

const appsecMetrics = telemetryMetrics.manager.namespace('appsec')

function increaseSdkEventMetric(eventType, version) {
  const tags = {
    event_type: eventType,
    sdk_version: version
  }

  console.log('ugaitz - tags', tags)
  appsecMetrics.count('sdk.event', tags).inc(1)
}

/**
 * @deprecated in favour of trackUserLoginSuccessV2
 */
function trackUserLoginSuccessEvent (tracer, user, metadata) {
  // TODO: better user check here and in _setUser() ?
  if (!user || !user.id) {
    log.warn('[ASM] Invalid user provided to trackUserLoginSuccessEvent')
    return
  }

  const rootSpan = getRootSpan(tracer)
  if (!rootSpan) {
    log.warn('[ASM] Root span not available in trackUserLoginSuccessEvent')
    return
  }

  setUserTags(user, rootSpan)

  const login = user.login ?? user.id

  metadata = { 'usr.login': login, ...metadata }


  trackEvent('users.login.success', metadata, 'trackUserLoginSuccessEvent', rootSpan)

  runWaf('users.login.success', { id: user.id, login })

  increaseSdkEventMetric('login_success', 'v1')
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
      setUserTags(user, rootSpan)
      metadata['usr'] = user
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
    log.warn('[ASM] Root span not available in v2.trackUserLoginSuccess')
    return
  }

  const wafData = { login }

  metadata = {
    'usr.login': login,
    'usr.exists': exists ? 'true' : 'false',
    ...metadata
  }

  trackEvent('users.login.failure', metadata, 'v2.trackUserLoginFailure', rootSpan)

  runWaf('users.login.failure', wafData)

  increaseSdkEventMetric('login_failure', 'v2')
}

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

  increaseSdkEventMetric('login_failure', 'v1')
}

function trackCustomEvent (tracer, eventName, metadata) {
  if (!eventName || typeof eventName !== 'string') {
    log.warn('[ASM] Invalid eventName provided to trackCustomEvent')
    return
  }

  trackEvent(eventName, metadata, 'trackCustomEvent', getRootSpan(tracer))

  increaseSdkEventMetric('custom', 'v1')
}

function flattenFields (fields, sdkMethodName, depth = 0) {
  if (depth > 4) {
    log.warn('[ASM] Too deep object provided in the SDK method %s, object truncated', sdkMethodName)
    return
  }
  const result = {}
  for (const key of Object.keys(fields)) {
    const value = fields[key]

    if (value && typeof value === 'object') {
      const flatValue = flattenFields(value, sdkMethodName, depth + 1)
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

  return result
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
    const flatFields = flattenFields(fields, sdkMethodName)
    for (const metadataKey of Object.keys(flatFields)) {
      tags[`appsec.events.${eventName}.${metadataKey}`] = '' + flatFields[metadataKey]
    }
  }

  rootSpan.addTags(tags)

  keepTrace(rootSpan, SAMPLING_MECHANISM_APPSEC)
  standalone.sample(rootSpan)
}

function runWaf (eventName, user) {
  const persistent = {
    [`server.business_logic.${eventName}`]: null
  }

  if (user.id) {
    persistent[addresses.USER_ID] = '' + user.id
  }

  if (user.login) {
    persistent[addresses.USER_LOGIN] = '' + user.login
  }

  console.log('ugaitz - persistent - ', persistent)
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
