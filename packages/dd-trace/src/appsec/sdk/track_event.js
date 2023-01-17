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
  const tags = {}
  tags['appsec.events.users.login.success.track'] = 'true'
  tags[MANUAL_KEEP] = 'true'
  if (metadata) {
    for (const metadataKey of Object.keys(metadata)) {
      tags[`appsec.events.users.login.success.${metadataKey}`] = '' + metadata[metadataKey]
    }
  }
  rootSpan.addTags(tags)
}

function trackUserLoginFailureEvent (tracer, userId, exists, metadata) {
  if (typeof userId !== 'string') {
    log.warn('Invalid userId provided to trackUserLoginFailureEvent')
    return
  }
  const rootSpan = getRootSpan(tracer)
  if (!rootSpan) {
    log.warn('Expected root span available in trackUserLoginFailureEvent')
    return
  }
  const tags = {}
  tags['appsec.events.users.login.failure.track'] = 'true'
  tags['appsec.events.users.login.failure.usr.id'] = userId
  tags['appsec.events.users.login.failure.usr.exists'] = exists ? 'true' : 'false'
  tags[MANUAL_KEEP] = 'true'
  if (metadata) {
    for (const metadataKey of Object.keys(metadata)) {
      tags[`appsec.events.users.login.failure.${metadataKey}`] = '' + metadata[metadataKey]
    }
  }
  rootSpan.addTags(tags)
}

function trackCustomEvent (tracer, eventName, metadata) {
  if (!eventName || typeof eventName !== 'string') {
    log.warn('Invalid eventName received in trackCustomEvent')
    return
  }
  const rootSpan = getRootSpan(tracer)
  if (!rootSpan) {
    log.warn('Expected root span available in trackCustomEvent')
    return
  }
  const tags = {}
  tags[`appsec.events.${eventName}.track`] = 'true'
  tags[MANUAL_KEEP] = 'true'
  for (const metadataKey of Object.keys(metadata)) {
    tags[`appsec.events.${eventName}.${metadataKey}`] = '' + metadata[metadataKey]
  }
  rootSpan.addTags(tags)
}

module.exports = {
  trackUserLoginSuccessEvent,
  trackUserLoginFailureEvent,
  trackCustomEvent
}
