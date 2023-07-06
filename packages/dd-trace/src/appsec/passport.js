'use strict'

const log = require('../log')
const { trackEvent } = require('./sdk/track_event')

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
    id: login
  }

  if (!user.id) {
    return user
  }

  if (passportUser) {
    // Guess id
    if (passportUser.id) {
      user.id = passportUser.id
    } else if (passportUser._id) {
      user.id = passportUser._id
    }

    if (mode === 'extended') {
      if (login) {
        user.login = login
      }

      if (passportUser.email) {
        user.email = passportUser.email
      }

      // Guess username
      if (passportUser.username) {
        user.username = passportUser.username
      } else if (passportUser.name) {
        user.username = passportUser.name
      }
    }
  }

  return user
}

function passportTrackEvent (credentials, passportUser, rootSpan, mode) {
  const user = parseUser(getLogin(credentials), passportUser, mode) // TODO: rename user to metadata

  if (user.id === undefined) {
    log.warn('No user ID found in authentication instrumentation')
    return
  }

  if (passportUser) {
    trackEvent('users.login.success', user, null, 'passportTrackEvent', rootSpan, mode)
  } else {
    const metadata = { user }
    trackEvent('users.login.failure', null, metadata, 'passportTrackEvent', rootSpan, mode)
  }
}

module.exports = {
  passportTrackEvent
}
