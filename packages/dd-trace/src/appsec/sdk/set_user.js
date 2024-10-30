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

  // must get user ID with USER_ID_FIELDS

  // _dd.appsec.user.collection_mode: collectionMode // sdk/ident/anon

  setUserTags(user, rootSpan)

  /*
    User IDs generated through the SDK must now be provided to libddwaf as a persistent addresses.
    If the user monitoring SDK has already resulted in a call to libddwaf before any automated instrumentation or collection method has been executed, no extra call should be made.
    If the automated instrumentation or collection method has resulted in a call to libddwaf before the user monitoring SDK has been executed, a second call must be performed with the user ID obtained through the SDK.
  */
  // will the second call trigger tho ? make some edge case tests
}

module.exports = {
  setUserTags,
  setUser
}
