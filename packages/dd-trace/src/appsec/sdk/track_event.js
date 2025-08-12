'use strict'

const log = require('../../log')
const { getRootSpan } = require('./utils')
const { setUserTags } = require('./set_user')
const waf = require('../waf')
const { keepTrace } = require('../../priority_sampler')
const addresses = require('../addresses')
const { ASM } = require('../../standalone/product')
const { incrementSdkEventMetric } = require('../telemetry')

/**
 * @deprecated in favor of trackUserLoginSuccessV2
 */
function trackUserLoginSuccessEvent (tracer, user, metadata) {
  // TODO: better user check here and in _setUser() ?
  if (!user || !user.id) {
    log.warn('[ASM] Invalid user provided to trackUserLoginSuccessEvent')
    return
  }

  incrementSdkEventMetric('login_success', 'v1')

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

  incrementSdkEventMetric('login_failure', 'v1')
}

function trackCustomEvent (tracer, eventName, metadata) {
  if (!eventName || typeof eventName !== 'string') {
    log.warn('[ASM] Invalid eventName provided to trackCustomEvent')
    return
  }

  trackEvent(eventName, metadata, 'trackCustomEvent', getRootSpan(tracer))

  incrementSdkEventMetric('custom', 'v1')

  if (eventName === 'users.login.success' || eventName === 'users.login.failure') {
    runWaf(eventName)
  }
}

function trackUserLoginSuccessV2 (tracer, login, user, metadata) {
  if (!login || typeof login !== 'string') {
    log.warn('[ASM] Invalid login provided to eventTrackingV2.trackUserLoginSuccess')
    return
  }

  incrementSdkEventMetric('login_success', 'v2')

  const rootSpan = getRootSpan(tracer)
  if (!rootSpan) {
    log.warn('[ASM] Root span not available in eventTrackingV2.trackUserLoginSuccess')
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
      metadata.usr = user
    }
  }

  trackEvent('users.login.success', metadata, 'eventTrackingV2.trackUserLoginSuccess', rootSpan)

  runWaf('users.login.success', wafData)
}

function trackUserLoginFailureV2 (tracer, login, exists, metadata) {
  if (!login || typeof login !== 'string') {
    log.warn('[ASM] Invalid login provided to eventTrackingV2.trackUserLoginFailure')
    return
  }

  incrementSdkEventMetric('login_failure', 'v2')

  const rootSpan = getRootSpan(tracer)
  if (!rootSpan) {
    log.warn('[ASM] Root span not available in eventTrackingV2.trackUserLoginFailure')
    return
  }

  const wafData = { login }

  if (exists !== null && typeof exists === 'object' && metadata === undefined) {
    metadata = exists
    exists = false
  }

  metadata = {
    'usr.login': login,
    'usr.exists': exists ? 'true' : 'false',
    ...metadata
  }

  trackEvent('users.login.failure', metadata, 'eventTrackingV2.trackUserLoginFailure', rootSpan)

  runWaf('users.login.failure', wafData)
}

function flattenFields (fields, depth = 0) {
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
      const { result: flatValue, truncated: inheritTruncated } = flattenFields(value, depth + 1)
      truncated = truncated || inheritTruncated

      if (flatValue) {
        for (const flatKey of Object.keys(flatValue)) {
          result[`${key}.${flatKey}`] = flatValue[flatKey]
        }
      }
    } else if (value !== undefined) {
      result[key] = value
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
    const { result: flatFields, truncated } = flattenFields(fields)

    if (truncated) {
      log.warn('[ASM] Too deep object provided in the SDK method %s, object truncated', sdkMethodName)
    }

    for (const metadataKey of Object.keys(flatFields)) {
      tags[`appsec.events.${eventName}.${metadataKey}`] = String(flatFields[metadataKey])
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
    persistent[addresses.USER_ID] = String(user.id)
  }

  if (user?.login) {
    persistent[addresses.USER_LOGIN] = String(user.login)
  }

  waf.run({ persistent })
}

module.exports = {
  trackUserLoginSuccessEvent,
  trackUserLoginFailureEvent,
  trackCustomEvent,
  trackUserLoginSuccessV2,
  trackUserLoginFailureV2,
  trackEvent,
  runWaf
}
