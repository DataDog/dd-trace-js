'use strict'

const { getRootSpan } = require('./utils')
const { MANUAL_KEEP } = require('../../../../../ext/tags')
const log = require('../../log')
function trackUserLoginSuccessEvent (tracer, user, metadata) {
  if (!user) {
    log.warn('User not provided to trackUserLoginSuccessEvent')
    return
  }
  const rootSpan = getRootSpan(tracer)
  if (!rootSpan) {
    log.warn('Expected root span available in trackUserLoginSuccessEvent')
    return
  }
  tracer.setUser(user)
  trackEvent(tracer, 'users.login.success', metadata, 'trackUserLoginSuccessEvent')
}

function trackUserLoginFailureEvent (tracer, userId, exists, metadata) {
  if (typeof userId !== 'string') {
    log.warn('Invalid userId provided to trackUserLoginFailureEvent')
    return
  }
  const fields = {
    'usr.id': userId,
    'usr.exists': exists ? 'true' : 'false',
    ...metadata
  }
  trackEvent(tracer, 'users.login.failure', fields, 'trackUserLoginFailureEvent')
}

function trackCustomEvent (tracer, eventName, metadata) {
  if (!eventName || typeof eventName !== 'string') {
    log.warn('Invalid eventName received in trackCustomEvent')
    return
  }
  trackEvent(tracer, eventName, metadata, 'trackCustomEvent')
}

function trackEvent (tracer, eventName, fields, sdkMethodName) {
  const rootSpan = getRootSpan(tracer)
  if (!rootSpan) {
    log.warn(`Expected root span available in ${sdkMethodName}`)
    return
  }
  const tags = {}
  tags[`appsec.events.${eventName}.track`] = 'true'
  tags[MANUAL_KEEP] = 'true'
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
  trackCustomEvent
}
