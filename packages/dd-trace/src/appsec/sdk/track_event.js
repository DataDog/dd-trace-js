'use strict'

const log = require('../../log')
const { getRootSpan } = require('./utils')
const { setUserTags } = require('./set_user')
const standalone = require('../standalone')
const waf = require('../waf')
const { SAMPLING_MECHANISM_APPSEC } = require('../../constants')
const { keepTrace } = require('../../priority_sampler')

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

  setUserTags(user, rootSpan)

  trackEvent('users.login.success', metadata, 'trackUserLoginSuccessEvent', rootSpan, 'sdk')
}

function trackUserLoginFailureEvent (tracer, userId, exists, metadata) {
  if (!userId || typeof userId !== 'string') {
    log.warn('Invalid userId provided to trackUserLoginFailureEvent')
    return
  }

  const fields = {
    'usr.id': userId,
    'usr.exists': exists ? 'true' : 'false',
    ...metadata
  }

  trackEvent('users.login.failure', fields, 'trackUserLoginFailureEvent', getRootSpan(tracer), 'sdk')
}

function trackCustomEvent (tracer, eventName, metadata) {
  if (!eventName || typeof eventName !== 'string') {
    log.warn('Invalid eventName provided to trackCustomEvent')
    return
  }

  trackEvent(eventName, metadata, 'trackCustomEvent', getRootSpan(tracer), 'sdk')
}

function trackEvent (eventName, fields, sdkMethodName, rootSpan, mode) {
  if (!rootSpan) {
    log.warn(`Root span not available in ${sdkMethodName}`)
    return
  }

  keepTrace(rootSpan, SAMPLING_MECHANISM_APPSEC)

  const tags = {
    [`appsec.events.${eventName}.track`]: 'true'
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

  standalone.sample(rootSpan)

  if (['users.login.success', 'users.login.failure'].includes(eventName)) {
    waf.run({ persistent: { [`server.business_logic.${eventName}`]: null } })
  }
}

module.exports = {
  trackUserLoginSuccessEvent,
  trackUserLoginFailureEvent,
  trackCustomEvent,
  trackEvent
}
