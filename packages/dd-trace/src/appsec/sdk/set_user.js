'use strict'

const { getRootSpan } = require('./utils')
const log = require('../../log')
const waf = require('../waf')

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

  const persistent = {}

  if (user.id) {
    persistent[addresses.USER_ID] = '' + user.id
  }

  if (user.login) {
    persistent[addresses.USER_LOGIN] = '' + user.login
  }

  waf.run({ persistent })
}

module.exports = {
  setUserTags,
  setUser
}
