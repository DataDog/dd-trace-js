'use strict'

const log = require('../log')
const { trackEvent } = require('./sdk/track_event')
const { setUserTags } = require('./sdk/set_user')
const crypto = require('crypto')

const SDK_USER_EVENT_PATTERN = '^_dd\\.appsec\\.events\\.users\\.[\\W\\w+]+\\.sdk$'
const regexSdkEvent = new RegExp(SDK_USER_EVENT_PATTERN, 'i')

// The user ID generated must be consistent and repeatable meaning that, for a given framework, the same field must always be used. 
const USER_ID_FIELDS = ['id', '_id', 'email', 'username', 'login', 'user']



function isSdkCalled (tags) {
  let called = false

  if (tags !== null && typeof tags === 'object') {
    called = Object.entries(tags).some(([key, value]) => regexSdkEvent.test(key) && value === 'true')
  }

  return called
}

function obfuscateId (id) {
  return 'anon_' + crypto.createHash('sha256').update(id).digest().toString('hex', 0, 16).toLowerCase()
}

// delete this function later if we know it's always credential.username
function getLogin (credentials) {
  const type = credentials && credentials.type
  let login
  if (type === 'local' || type === 'http') {
    login = credentials.username

    if (collectionMode === 'anon') {
      login = obfuscateId(login)
    }
  }

  return login
}

function getUserId (passportUser) {
  for (const field of USER_ID_FIELDS) {
    let id = passportUser[field]
    if (id) {
      if (collectionMode === 'anon') {
        id = obfuscateId(id)
      }

      return id
    }
  }
}

// TODO passpoort-jwt ?

// TODO: SDK always has precendence ?
// Whenever relevant, the user ID must be collected by the libraries as part of the root span, using the tag usr.id.
// Whenever relevant, the user login must be collected by the libraries as part of the root span, using the tag usr.login.


/*
These modes only impact automated user ID and login collection, either for business logic events or for authenticated user tracking, and should be disregarded when the collection is performed through the various SDKs. 


In the disabled mode, as the name suggests, libraries should not collect user ID or user login. Effectively, this means that libraries shouldn’t send automated business logic events, specifically login and signup events, nor should they automatically track authenticated requests.
*/

function passportTrackEvent (credentials, passportUser, rootSpan) {
  if (!collectionMode) return

  const tags = rootSpan && rootSpan.context() && rootSpan.context()._tags

  // TODO: what if sdk is called after automated user

  if (isSdkCalled(tags)) {
    // Don't overwrite tags set by SDK callings
    return
  }

  // If a passportUser object is published then the login succeded
  if (passportUser) {
    const userId = getUserId(passportUser)

    if (userId === undefined) {
      log.warn('No user ID found in authentication instrumentation')
      //  telemetry counter: 'appsec.instrum.user_auth.missing_user_id' 
      return
    }

    setUserTags({ id: userId }, rootSpan)

    trackEvent('users.login.success', null, 'passportTrackEvent', rootSpan, collectionMode)

    // call WAF ephemeral
  } else {
    const login = getLogin(credentials)

    if (!login) {
      return // idk
    }

    trackEvent('users.login.failure', { 'usr.id': login, login }, 'passportTrackEvent', rootSpan, collectionMode)
  }
}

function passportTrackUser (session) {
  if (!collectionMode) return

  const userId = getUserId(session.passport.user)

  // call WAF ephemeral

}

module.exports = {
  passportTrackEvent,
  setCollectionMode
}
