'use strict'

const crypto = require('crypto')
const log = require('../log')
const telemetry = require('./telemetry')
const addresses = require('./addresses')
const { keepTrace } = require('../priority_sampler')
const { SAMPLING_MECHANISM_APPSEC } = require('../constants')
const standalone = require('./standalone')
const waf = require('./waf')

// the RFC doesn't include '_id', but it's common in MongoDB
const USER_ID_FIELDS = ['id', '_id', 'email', 'username', 'login', 'user']

let collectionMode

function setCollectionMode (mode, overwrite = true) {
  // don't overwrite if already set, only used in appsec/index.js to not overwrite RC values
  if (!overwrite && collectionMode) return

  /* eslint-disable no-fallthrough */
  switch (mode) {
    case 'safe':
      log.warn('[ASM] Using deprecated value "safe" in config.appsec.eventTracking.mode')
    case 'anon':
    case 'anonymization':
      collectionMode = 'anonymization'
      break

    case 'extended':
      log.warn('[ASM] Using deprecated value "extended" in config.appsec.eventTracking.mode')
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
    // get first 16 bytes of sha256 hash in lowercase hex
    return 'anon_' + crypto.createHash('sha256').update(str).digest().toString('hex', 0, 16).toLowerCase()
  } else {
    return str
  }
}

// TODO: should we find other ways to get the user ID ?
function getUserId (user) {
  if (!user) return

  // should we iterate on user keys instead to be case insensitive ?
  // but if we iterate over user then we're missing the inherited props ?
  for (const field of USER_ID_FIELDS) {
    let id = user[field]

    // try to find a field that can be stringified
    if (id && typeof id.toString === 'function') {
      id = id.toString()

      if (typeof id !== 'string' || id.startsWith('[object ')) {
        // probably not a usable ID ?
        continue
      }

      return obfuscateIfNeeded(id)
    }
  }
}

function trackLogin (framework, login, user, success, rootSpan) {
  if (!collectionMode || collectionMode === 'disabled') return

  if (typeof login !== 'string') {
    log.error('[ASM] Invalid login provided to AppSec trackLogin')

    telemetry.incrementMissingUserLoginMetric(framework, success ? 'login_success' : 'login_failure')
    // note:
    //  if we start supporting using userId if login is missing, we need to only give up if both are missing, and
    //  implement 'appsec.instrum.user_auth.missing_user_id' telemetry too
    return
  }

  login = obfuscateIfNeeded(login)
  const userId = getUserId(user)

  let newTags

  const persistent = {
    [addresses.USER_LOGIN]: login
  }

  const currentTags = rootSpan.context()._tags
  const isSdkCalled = currentTags[`_dd.appsec.events.users.login.${success ? 'success' : 'failure'}.sdk`] === 'true'

  // used to not overwrite tags set by SDK
  function shouldSetTag (tag) {
    return !(isSdkCalled && currentTags[tag])
  }

  if (success) {
    newTags = {
      'appsec.events.users.login.success.track': 'true',
      '_dd.appsec.events.users.login.success.auto.mode': collectionMode,
      '_dd.appsec.usr.login': login
    }

    if (shouldSetTag('appsec.events.users.login.success.usr.login')) {
      newTags['appsec.events.users.login.success.usr.login'] = login
    }

    if (userId) {
      newTags['_dd.appsec.usr.id'] = userId

      if (shouldSetTag('usr.id')) {
        newTags['usr.id'] = userId
        persistent[addresses.USER_ID] = userId
      }
    }

    persistent[addresses.LOGIN_SUCCESS] = null
  } else {
    newTags = {
      'appsec.events.users.login.failure.track': 'true',
      '_dd.appsec.events.users.login.failure.auto.mode': collectionMode,
      '_dd.appsec.usr.login': login
    }

    if (shouldSetTag('appsec.events.users.login.failure.usr.login')) {
      newTags['appsec.events.users.login.failure.usr.login'] = login
    }

    if (userId) {
      newTags['_dd.appsec.usr.id'] = userId

      if (shouldSetTag('appsec.events.users.login.failure.usr.id')) {
        newTags['appsec.events.users.login.failure.usr.id'] = userId
      }
    }

    /* TODO: if one day we have this info
    if (exists != null && shouldSetTag('appsec.events.users.login.failure.usr.exists')) {
      newTags['appsec.events.users.login.failure.usr.exists'] = exists
    }
    */

    persistent[addresses.LOGIN_FAILURE] = null
  }

  keepTrace(rootSpan, SAMPLING_MECHANISM_APPSEC)
  standalone.sample(rootSpan)

  rootSpan.addTags(newTags)

  return waf.run({ persistent })
}

function trackUser (user, rootSpan) {
  if (!collectionMode || collectionMode === 'disabled') return

  const userId = getUserId(user)
  if (!userId) {
    log.error('[ASM] No valid user ID found in AppSec trackUser')
    telemetry.incrementMissingUserIdMetric('passport', 'authenticated_request')
    return
  }

  rootSpan.setTag('_dd.appsec.usr.id', userId)

  const isSdkCalled = rootSpan.context()._tags['_dd.appsec.user.collection_mode'] === 'sdk'
  // do not override SDK
  if (!isSdkCalled) {
    rootSpan.addTags({
      'usr.id': userId,
      '_dd.appsec.user.collection_mode': collectionMode
    })

    return waf.run({
      persistent: {
        [addresses.USER_ID]: userId
      }
    })
  }
}

module.exports = {
  setCollectionMode,
  trackLogin,
  trackUser
}
