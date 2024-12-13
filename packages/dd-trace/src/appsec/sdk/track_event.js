'use strict'

const log = require('../../log')
const { getRootSpan } = require('./utils')
const { setUserTags } = require('./set_user')
const standalone = require('../standalone')
const waf = require('../waf')
const { SAMPLING_MECHANISM_APPSEC } = require('../../constants')
const { keepTrace } = require('../../priority_sampler')
const addresses = require('../addresses')

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
}

function trackCustomEvent (tracer, eventName, metadata) {
  if (!eventName || typeof eventName !== 'string') {
    log.warn('[ASM] Invalid eventName provided to trackCustomEvent')
    return
  }

  trackEvent(eventName, metadata, 'trackCustomEvent', getRootSpan(tracer))
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
    for (const metadataKey of Object.keys(fields)) {
      tags[`appsec.events.${eventName}.${metadataKey}`] = '' + fields[metadataKey]
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

  waf.run({ persistent })
}

module.exports = {
  trackUserLoginSuccessEvent,
  trackUserLoginFailureEvent,
  trackCustomEvent
}
