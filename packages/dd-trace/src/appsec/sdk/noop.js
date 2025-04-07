'use strict'

class NoopEventTrackingV2 {
  trackUserLoginSuccess () {}

  trackUserLoginFailure () {}
}

class NoopAppsecSdk {
  constructor () {
    this.eventTrackingV2 = new NoopEventTrackingV2()
  }

  trackUserLoginSuccessEvent () {}

  trackUserLoginFailureEvent () {}

  trackCustomEvent () {}

  isUserBlocked () {}

  blockRequest () {}

  setUser () {}
}

module.exports = NoopAppsecSdk
