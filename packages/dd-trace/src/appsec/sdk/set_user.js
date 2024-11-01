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
    log.warn('Invalid user provided to setUser')
    return
  }

  const rootSpan = getRootSpan(tracer)
  if (!rootSpan) {
    log.warn('Root span not available in setUser')
    return
  }

  // must get user ID with USER_ID_FIELDS

  setTags({
    'usr.id': userId,
    '_dd.appsec.user.collection_mode': 'sdk/ident/anon'
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

}

module.exports = {
  setUserTags,
  setUser
}
