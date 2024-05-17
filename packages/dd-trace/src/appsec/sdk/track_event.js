'use strict'

const log = require('../../log')
const { getRootSpan } = require('./utils')
const { MANUAL_KEEP } = require('../../../../../ext/tags')
const { setUserTags } = require('./set_user')
const { APPSEC_PROPAGATION_KEY } = require('../../constants')

function trackUserLoginSuccessEvent (tracer, user, metadata, standaloneEnabled) {
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

  setUserTags(user, rootSpan)

  trackEvent('users.login.success', metadata, 'trackUserLoginSuccessEvent', rootSpan, 'sdk', standaloneEnabled)
}

function trackUserLoginFailureEvent (tracer, userId, exists, metadata, standaloneEnabled) {
  if (!userId || typeof userId !== 'string') {
    log.warn('Invalid userId provided to trackUserLoginFailureEvent')
    return
  }

  const fields = {
    'usr.id': userId,
    'usr.exists': exists ? 'true' : 'false',
    ...metadata
  }

  trackEvent('users.login.failure', fields, 'trackUserLoginFailureEvent', getRootSpan(tracer), 'sdk',
    standaloneEnabled)
}

function trackCustomEvent (tracer, eventName, metadata, standaloneEnabled) {
  if (!eventName || typeof eventName !== 'string') {
    log.warn('Invalid eventName provided to trackCustomEvent')
    return
  }

  trackEvent(eventName, metadata, 'trackCustomEvent', getRootSpan(tracer), 'sdk', standaloneEnabled)
}

function trackEvent (eventName, fields, sdkMethodName, rootSpan, mode, standaloneEnabled) {
  if (!rootSpan) {
    log.warn(`Root span not available in ${sdkMethodName}`)
    return
  }

  const tags = {
    [`appsec.events.${eventName}.track`]: 'true',
    [MANUAL_KEEP]: 'true'
  }

  if (standaloneEnabled) {
    tags[APPSEC_PROPAGATION_KEY] = '1'
  }

  if (mode === 'sdk') {
    tags[`_dd.appsec.events.${eventName}.sdk`] = 'true'
  }

  if (mode === 'safe' || mode === 'extended') {
    tags[`_dd.appsec.events.${eventName}.auto.mode`] = mode
  }

  if (fields) {
    for (const metadataKey of Object.keys(fields)) {
      tags[`appsec.events.${eventName}.${metadataKey}`] = '' + fields[metadataKey]
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
