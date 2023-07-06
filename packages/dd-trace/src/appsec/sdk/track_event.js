'use strict'

const log = require('../../log')
const { getRootSpan } = require('./utils')
const { MANUAL_KEEP } = require('../../../../../ext/tags')
const { setUserTags } = require('./set_user')

const UUID_PATTERN = '^[0-9A-F]{8}-[0-9A-F]{4}-[1-5][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$'
const regexUsername = new RegExp(UUID_PATTERN, 'i')

const SDK_USER_EVENT_PATTERN = '^_dd\\.appsec\\.events\\.users\\.[\\W\\w+]+\\.sdk$'
const regexSdkEvent = new RegExp(SDK_USER_EVENT_PATTERN, 'i')

function isSdkCalled (rootSpan) {
  const tags = rootSpan && rootSpan.context() && rootSpan.context()._tags
  let called = false

  if (tags && typeof tags === 'object') {
    called = Object.entries(tags).some(([key, value]) => regexSdkEvent.test(key) && value === 'true')
  }

  return called
}

function trackUserLoginSuccessEvent (tracer, user, metadata) {
  // TODO: better user check here and in _setUser() ?
  if (!user || !user.id) {
    log.warn('Invalid user provided to trackUserLoginSuccessEvent')
    return
  }

  const rootSpan = getRootSpan(tracer)
  if (!rootSpan) {
    log.warn('Root span not available in trackUserLoginSuccessEvent')
    return
  }

  const mData = { custom: { ...metadata } }

  trackEvent('users.login.success', user, mData, 'trackUserLoginSuccessEvent', rootSpan, 'sdk')
}

function trackUserLoginFailureEvent (tracer, userId, exists, metadata) {
  if (!userId || typeof userId !== 'string') {
    log.warn('Invalid userId provided to trackUserLoginFailureEvent')
    return
  }

  const mData = {
    user: {
      id: userId,
      exists: exists
    },
    custom: { ...metadata }
  }

  trackEvent('users.login.failure', null, mData, 'trackUserLoginFailureEvent', getRootSpan(tracer), 'sdk')
}

function trackCustomEvent (tracer, eventName, metadata) {
  if (!eventName || typeof eventName !== 'string') {
    log.warn('Invalid eventName provided to trackCustomEvent')
    return
  }

  const mData = { custom: { ...metadata }
  }

  trackEvent(eventName, null, mData, 'trackCustomEvent', getRootSpan(tracer), 'sdk')
}

function trackEvent (eventName, user, metadata, sdkMethodName, rootSpan, mode) {
  if (!rootSpan) {
    log.warn(`Root span not available in ${sdkMethodName}`)
    return
  }

  const tags = {
    [`appsec.events.${eventName}.track`]: 'true',
    [MANUAL_KEEP]: 'true'
  }

  if (mode === 'sdk') {
    tags[`_dd.appsec.events.${eventName}.sdk`] = 'true'
  }

  if (mode === 'safe' || mode === 'extended') {
    tags[`_dd.appsec.events.${eventName}.auto.mode`] = mode
  }

  if (mode === 'safe') {
    // Remove PII in safe mode
    if (user) {
      if (!regexUsername.test(user.id)) {
        user = null
      }
    }

    if (metadata && metadata.user) {
      if (metadata.user.id && !regexUsername.test(metadata.user.id)) {
        metadata = null
      }
    }
  }

  if (mode === 'sdk' || ((mode === 'safe' || mode === 'extended') && !isSdkCalled(rootSpan))) {
    if (user) {
      setUserTags(user, rootSpan)
    }

    if (metadata) {
      if (metadata.user) {
        for (const userKey of Object.keys(metadata.user)) {
          tags[`appsec.events.${eventName}.usr.${userKey}`] = '' + metadata.user[userKey]
        }
      }

      if (metadata.custom) {
        for (const metadataKey of Object.keys(metadata.custom)) {
          tags[`appsec.events.${eventName}.${metadataKey}`] = '' + metadata.custom[metadataKey]
        }
      }
    }
  }

  rootSpan.addTags(tags)
}

module.exports = {
  trackUserLoginSuccessEvent,
  trackUserLoginFailureEvent,
  trackCustomEvent,
  trackEvent
}
