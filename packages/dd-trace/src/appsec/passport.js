'use strict'

const log = require('../log')
const { trackEvent } = require('./sdk/track_event')
const { setUserTags } = require('./sdk/set_user')

const UUID_PATTERN = '^[0-9A-F]{8}-[0-9A-F]{4}-[1-5][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$'
const regexUsername = new RegExp(UUID_PATTERN, 'i')

const SDK_USER_EVENT_PATTERN = '^_dd\\.appsec\\.events\\.users\\.[\\W\\w+]+\\.sdk$'
const regexSdkEvent = new RegExp(SDK_USER_EVENT_PATTERN, 'i')

function isSdkCalled (tags) {
  let called = false

  if (tags && typeof tags === 'object') {
    called = Object.entries(tags).some(([key, value]) => regexSdkEvent.test(key) && value === 'true')
  }

  return called
}

// delete this function later if we know it's always credential.username
function getLogin (credentials) {
  const type = credentials && credentials.type
  let login
  if (type === 'local' || type === 'http') {
    login = credentials.username
  }

  return login
}

function parseUser (login, passportUser, mode) {
  const user = {
    'usr.id': login
  }

  if (!user['usr.id']) {
    return user
  }

  if (passportUser) {
    // Guess id
    if (passportUser.id) {
      user['usr.id'] = passportUser.id
    } else if (passportUser._id) {
      user['usr.id'] = passportUser._id
    }

    if (mode === 'extended') {
      if (login) {
        user['usr.login'] = login
      }

      if (passportUser.email) {
        user['usr.email'] = passportUser.email
      }

      // Guess username
      if (passportUser.username) {
        user['usr.username'] = passportUser.username
      } else if (passportUser.name) {
        user['usr.username'] = passportUser.name
      }
    }
  }

  if (mode === 'safe') {
    // Remove PII in safe mode
    if (!regexUsername.test(user['usr.id'])) {
      user['usr.id'] = ''
    }
  }

  return user
}

function passportTrackEvent (credentials, passportUser, rootSpan, mode) {
  const tags = rootSpan && rootSpan.context() && rootSpan.context()._tags

  if (isSdkCalled(tags)) {
    // Don't overwrite tags set by SDK callings
    return
  }
  const user = parseUser(getLogin(credentials), passportUser, mode)

  if (user['usr.id'] === undefined) {
    log.warn('No user ID found in authentication instrumentation')
    return
  }

  if (passportUser) {
    // If a passportUser object is published then the login succeded
    const userTags = {}
    Object.entries(user).forEach(([k, v]) => {
      const attr = k.split('.', 2)[1]
      userTags[attr] = v
    })

    setUserTags(userTags, rootSpan)
    trackEvent('users.login.success', null, 'passportTrackEvent', rootSpan, mode)
  } else {
    trackEvent('users.login.failure', user, 'passportTrackEvent', rootSpan, mode)
  }
}

module.exports = {
  passportTrackEvent
}
