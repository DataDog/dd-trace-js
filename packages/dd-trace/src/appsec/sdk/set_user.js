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

  // must get user ID with USER_ID_FIELDS

  setTags({
    'usr.id': userId,
    '_dd.appsec.user.collection_mode': 'sdk'
  })

  /*
  When the user monitoring SDK is available and in use, the following applies:
  The usr.id must be set to the value provided through the user monitoring SDK.
  The span tag _dd.appsec.user.collection_mode must be set to sdk.
  This effectively means that the automated user ID collection mechanism must not overwrite the aforementioned span tags, while the user monitoring SDK must overwrite them if present.
  */



  /*
  When a user provides their own session ID through the use of the SDK using the session_id key:
  If libddwaf hasn’t already been called with the usr.session_id address, it should be called with the provided session_id and further calls through the automated collection method should be inhibited.
  If libddwaf has already been called with the usr.session_id address, it should be called again.
  */
  if (user.session_id && typeof user.session_id === 'string') {
    persistent['usr.session_id'] = user.session_id
  }
  


  setUserTags(user, rootSpan)

  // If the automated instrumentation or collection method has resulted in a call to libddwaf before the user monitoring SDK has been executed, a second call must be performed with the user ID obtained through the SDK.
  // will the second call trigger tho ? make some edge case tests
  const results = waf.run({
    persistent: {
      [USER_ID]: userId
    }
  })



  const persistent = {}

  if (user.id) {
    persistent[addresses.USER_ID] = '' + user.id
  }

  if (user.login) {
    persistent[addresses.USER_LOGIN] = '' + user.login
  }

  waf.run({ persistent })

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
