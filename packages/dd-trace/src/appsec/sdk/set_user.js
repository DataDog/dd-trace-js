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
    log.warn('Invalid user provided to setUser')
    return
  }

  const rootSpan = getRootSpan(tracer)
  if (!rootSpan) {
    log.warn('Root span not available in setUser')
    return
  }

  setUserTags(user, rootSpan)
}

module.exports = {
  setUserTags,
  setUser
}
