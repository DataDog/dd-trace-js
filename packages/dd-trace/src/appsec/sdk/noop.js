class AppsecSdk {
  trackUserLoginSuccessEvent (user, metadata) { }

  trackUserLoginFailureEvent (userId, exists, metadata) { }

  trackCustomEvent (eventName, metadata) { }
}
module.exports = AppsecSdk
