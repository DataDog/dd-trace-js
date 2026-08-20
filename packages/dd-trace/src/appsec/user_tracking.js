'use strict'

const crypto = require('crypto')
const log = require('../log')
const eventWriter = require('../opentracing/event-writer')
const { keepTrace } = require('../priority_sampler')
const { ASM } = require('../standalone/product')
const telemetry = require('./telemetry')
const addresses = require('./addresses')
const waf = require('./waf')

// the RFC doesn't include '_id', but it's common in MongoDB
const USER_ID_FIELDS = ['id', '_id', 'email', 'username', 'login', 'user']
const LOGIN_SUCCESS_SDK_OWNED_TAGS = new Set([
  'appsec.events.users.login.success.usr.login',
  'usr.id',
])
const LOGIN_FAILURE_SDK_OWNED_TAGS = new Set([
  'appsec.events.users.login.failure.usr.login',
  'appsec.events.users.login.failure.usr.id',
])

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
  return collectionMode === 'anonymization'
    // get first 16 bytes of sha256 hash in lowercase hex
    ? 'anon_' + crypto.createHash('sha256').update(str).digest().toString('hex', 0, 16).toLowerCase()
    : str
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
    [addresses.USER_LOGIN]: login,
  }

  const sdkTag = `_dd.appsec.events.users.login.${success ? 'success' : 'failure'}.sdk`
  let sdkOwnedTags

  if (success) {
    newTags = {
      'appsec.events.users.login.success.track': 'true',
      'appsec.events.users.login.success.usr.login': login,
      '_dd.appsec.events.users.login.success.auto.mode': collectionMode,
      '_dd.appsec.usr.login': login,
    }

    if (userId) {
      newTags['_dd.appsec.usr.id'] = userId
      newTags['usr.id'] = userId
    }

    sdkOwnedTags = LOGIN_SUCCESS_SDK_OWNED_TAGS
    persistent[addresses.LOGIN_SUCCESS] = null
  } else {
    newTags = {
      'appsec.events.users.login.failure.track': 'true',
      'appsec.events.users.login.failure.usr.login': login,
      '_dd.appsec.events.users.login.failure.auto.mode': collectionMode,
      '_dd.appsec.usr.login': login,
    }

    if (userId) {
      newTags['_dd.appsec.usr.id'] = userId
      newTags['appsec.events.users.login.failure.usr.id'] = userId
    }

    /* TODO: if one day we have this info
    if (exists != null && shouldSetTag('appsec.events.users.login.failure.usr.exists')) {
      newTags['appsec.events.users.login.failure.usr.exists'] = exists
    }
    */

    sdkOwnedTags = LOGIN_FAILURE_SDK_OWNED_TAGS
    persistent[addresses.LOGIN_FAILURE] = null
  }

  keepTrace(rootSpan, ASM)

  const userIdWritten = eventWriter.setAppSecAutoLoginTags(
    rootSpan,
    sdkTag,
    newTags,
    sdkOwnedTags,
    'usr.id'
  )
  if (success && userId && userIdWritten) persistent[addresses.USER_ID] = userId

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

  if (eventWriter.setAppSecAutoUser(rootSpan, userId, collectionMode)) {
    return waf.run({
      persistent: {
        [addresses.USER_ID]: userId,
      },
    })
  }
}

module.exports = {
  setCollectionMode,
  trackLogin,
  trackUser,
}
