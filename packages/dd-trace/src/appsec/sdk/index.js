'use strict'

const { trackUserLoginSuccessEvent, trackUserLoginFailureEvent, trackCustomEvent } = require('./track_event')

class AppsecSdk {
  constructor (tracer) {
    this._tracer = tracer
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
}

module.exports = AppsecSdk
