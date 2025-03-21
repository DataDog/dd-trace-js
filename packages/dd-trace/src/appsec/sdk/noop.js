'use strict'

class NoopAppsecSdkV2 {
  trackUserLoginSuccess () {}

  trackUserLoginFailure () {}
}

class NoopAppsecSdk {
  constructor () {
    this.v2 = new NoopAppsecSdkV2()
  }

  trackUserLoginSuccessEvent () {}

  trackUserLoginFailureEvent () {}

  trackCustomEvent () {}

  isUserBlocked () {}

  blockRequest () {}

  setUser () {}
}

module.exports = NoopAppsecSdk
