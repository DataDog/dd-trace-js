'use strict'

class NoopAppsecSdk {
  trackUserLoginSuccessEvent () {}

  trackUserLoginFailureEvent () {}

  trackCustomEvent () {}
}

module.exports = NoopAppsecSdk
