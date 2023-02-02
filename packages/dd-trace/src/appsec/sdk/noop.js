'use strict'

class NoopAppsecSDK {
  trackUserLoginSuccessEvent () {}

  trackUserLoginFailureEvent () {}

  trackCustomEvent () {}

  isUserBlocked () {}

  blockRequest () {}

  setUser () {}
}

module.exports = NoopAppsecSDK
