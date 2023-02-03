'use strict'

class NoopAppsecSdk {
  trackUserLoginSuccessEvent () {}

  trackUserLoginFailureEvent () {}

  trackCustomEvent () {}

  isUserBlocked () {}

  blockRequest () {}

  setUser () {}
}

module.exports = NoopAppsecSdk
