'use strict'

const {
  trackUserLoginSuccessEvent,
  trackUserLoginFailureEvent,
  trackCustomEvent,
  trackUserLoginSuccessV2,
  trackUserLoginFailureV2
} = require('./track_event')
const { checkUserAndSetUser, blockRequest } = require('./user_blocking')
const { setTemplates } = require('../blocking')
const { setUser } = require('./set_user')

class EventTrackingV2 {
  constructor (tracer) {
    this._tracer = tracer
  }

  trackUserLoginSuccess (login, user, metadata) {
    trackUserLoginSuccessV2(this._tracer, login, user, metadata)
  }

  trackUserLoginFailure (login, exists, metadata) {
    trackUserLoginFailureV2(this._tracer, login, exists, metadata)
  }
}

class AppsecSdk {
  constructor (tracer, config) {
    this._tracer = tracer
    if (config) {
      setTemplates(config)
    }

    this.eventTrackingV2 = new EventTrackingV2(tracer)
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
