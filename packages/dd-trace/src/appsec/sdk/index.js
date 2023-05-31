'use strict'

const { trackUserLoginSuccessEvent, trackUserLoginFailureEvent, trackCustomEvent } = require('./track_event')
const { checkUserAndSetUser, blockRequest } = require('./user_blocking')
const { setTemplates } = require('../blocking')
const { setUser } = require('./set_user')

class AppsecSdk {
  constructor (tracer, config) {
    this._tracer = tracer
    if (config) {
      setTemplates(config)
    }
  }

  trackUserLoginSuccessEvent (user, metadata) {
    return trackUserLoginSuccessEvent(this._tracer, user, metadata)
  }

  trackUserLoginFailureEvent (userId, exists, metadata) {
    return trackUserLoginFailureEvent(this._tracer, userId, exists, metadata)
  }

  trackCustomEvent (eventName, metadata) {
    return trackCustomEvent(this._tracer, eventName, metadata)
  }

  isUserBlocked (user) {
    return checkUserAndSetUser(this._tracer, user)
  }

  blockRequest (req, res) {
    return blockRequest(this._tracer, req, res)
  }

  setUser (user) {
    return setUser(this._tracer, user)
  }
}

module.exports = AppsecSdk
