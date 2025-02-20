'use strict'

const { getRootSpan } = require('./utils')
const log = require('../../log')
const waf = require('../waf')
const addresses = require('../addresses')

function setUserTags (user, rootSpan) {
  for (const k of Object.keys(user)) {
    rootSpan.setTag(`usr.${k}`, '' + user[k])
  }
}

function setUser (tracer, user) {
  if (!user || !user.id) {
    log.warn('[ASM] Invalid user provided to setUser')
    return
  }

  const rootSpan = getRootSpan(tracer)
  if (!rootSpan) {
    log.warn('[ASM] Root span not available in setUser')
    return
  }

  setUserTags(user, rootSpan)
  rootSpan.setTag('_dd.appsec.user.collection_mode', 'sdk')

  const persistent = {
    [addresses.USER_ID]: '' + user.id
  }

  if (user.session_id && typeof user.session_id === 'string') {
    persistent[addresses.USER_SESSION_ID] = user.session_id
  }

  waf.run({ persistent })
}

module.exports = {
  setUserTags,
  setUser
}
