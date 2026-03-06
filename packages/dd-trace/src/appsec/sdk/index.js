'use strict'

const { setTemplates } = require('../blocking')
const {
  trackUserLoginSuccessEvent,
  trackUserLoginFailureEvent,
  trackCustomEvent,
  trackUserLoginSuccessV2,
  trackUserLoginFailureV2,
} = require('./track_event')
const { checkUserAndSetUser, blockRequest } = require('./user_blocking')
const { setUser } = require('./set_user')

class EventTrackingV2 {
  #tracer

  constructor (tracer) {
    this.#tracer = tracer
  }

  trackUserLoginSuccess (login, user, metadata) {
    trackUserLoginSuccessV2(this.#tracer, login, user, metadata)
  }

  trackUserLoginFailure (login, exists, metadata) {
    trackUserLoginFailureV2(this.#tracer, login, exists, metadata)
  }
}

class AppsecSdk {
  #tracer

  constructor (tracer, config) {
    this.#tracer = tracer
    if (config) {
      setTemplates(config)
    }

    this.eventTrackingV2 = new EventTrackingV2(tracer)
  }

  trackUserLoginSuccessEvent (user, metadata) {
    return trackUserLoginSuccessEvent(this.#tracer, user, metadata)
  }

  trackUserLoginFailureEvent (userId, exists, metadata) {
    return trackUserLoginFailureEvent(this.#tracer, userId, exists, metadata)
  }

  trackCustomEvent (eventName, metadata) {
    return trackCustomEvent(this.#tracer, eventName, metadata)
  }

  isUserBlocked (user) {
    return checkUserAndSetUser(this.#tracer, user)
  }

  blockRequest (req, res) {
    return blockRequest(this.#tracer, req, res)
  }

  setUser (user) {
    return setUser(this.#tracer, user)
  }
}

module.exports = AppsecSdk
