'use strict'

const crypto = require('crypto')
const log = require('../../log')

// the official list doesn't include '_id', but it's common in MongoDB
const USER_ID_FIELDS = ['id', '_id', 'email', 'username', 'login', 'user']

let collectionMode

function setCollectionMode (mode, overwrite = true) {
  // don't overwrite if already set, only used in appsec/index.js to not overwrite RC values
  if (!overwrite && collectionMode) return

  /* eslint-disable no-fallthrough */
  switch (mode) {
    case 'safe':
      log.warn('Using deprecated value "safe" in config.appsec.eventTracking.mode')
    case 'anon':
    case 'anonymization':
      collectionMode = 'anonymization'
      break

    case 'extended':
      log.warn('Using deprecated value "extended" in config.appsec.eventTracking.mode')
    case 'ident':
    case 'identification':
      collectionMode = 'identification'
      break

    default:
      collectionMode = 'disabled'
  }
  /* eslint-enable no-fallthrough */
}

function obfuscateIfNeeded (str) {
  if (collectionMode === 'anonymization') {
    return 'anon_' + crypto.createHash('sha256').update(str).digest().toString('hex', 0, 16).toLowerCase()
  } else {
    return str
  }
}

function getUserId (user) {
  if (!user) return

  for (const field of USER_ID_FIELDS) {
    let id = user[field]
    if (id && typeof id.toString === 'function') {
      id = id.toString()

      if (id.startsWith('[object ')) {
        // probably not a usable ID ?
        continue
      }

      return obfuscateIfNeeded(id)
    }
  }
}

function obfuscateId (id) {
  return 'anon_' + crypto.createHash('sha256').update(id).digest().toString('hex', 0, 16).toLowerCase()
}

function trackLogin (login, user, success, rootSpan) {
  if (!collectionMode) return

  // TODO: what if sdk is called after automated user

  if (isSdkCalled(tags)) {
    // Don't overwrite tags set by SDK callings
    return
  }

  if (collectionMode === 'anon') {
    login = obfuscateId(login)
  }

  if (success) {
    // getID
    sdk.trackEvent('users.login.success', null, 'passportTrackEvent', rootSpan, collectionMode)
  } else {

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

module.exports = {
  setCollectionMode,
  trackLogin
}
