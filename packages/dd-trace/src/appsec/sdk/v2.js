'use strict'

const { trackUserLoginSuccessV2, trackUserLoginFailureV2 } = require('./track_event')

class AppsecSdkV2 {
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

module.exports = AppsecSdkV2
