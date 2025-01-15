'use strict'

const { getRootSpan } = require('./utils')
const log = require('../../log')

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

  /*
  When a user provides their own session ID through the use of the SDK using the session_id key:
  If libddwaf hasn’t already been called with the usr.session_id address, it should be called with the provided session_id and further calls through the automated collection method should be inhibited.
  If libddwaf has already been called with the usr.session_id address, it should be called again.
  */
  if (user.session_id && typeof user.session_id === 'string') {
    persistent['usr.session_id'] = user.session_id
  }

  setUserTags(user, rootSpan)
}

module.exports = {
  setUserTags,
  setUser
}
