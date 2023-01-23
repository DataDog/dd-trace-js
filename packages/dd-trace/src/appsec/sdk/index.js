'use strict'

const { trackUserLoginSuccessEvent, trackUserLoginFailureEvent, trackCustomEvent } = require('./track_event')
const { isUserBlocked } = require('./user_blocking')
const { block, loadTemplates } = require('../blocking')
const { getRootSpan } = require('./utils')
const { storage } = require('../../../../datadog-core')

class AppsecSDK {
  constructor (tracer, config) {
    this._tracer = tracer
    if (config) {
      loadTemplates(config)
    }
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
    if (!user || !user.id) {
      return false
    }

    const rootSpan = getRootSpan(this._tracer)
    if (!rootSpan) {
      return false
    }

    const userId = rootSpan.context()._tags['usr.id']
    if (!userId) {
      this._setUser({ id: user.id }, rootSpan)
    }
    return isUserBlocked(user)
  }

  blockRequest (req, res) {
    let request, response
    if (!req || !res) {
      const store = storage.getStore()
      request = req || store.req
      response = res || store.res
    } else {
      request = req
      response = res
    }

    if (!request || !response) {
      return false
    }

    const topSpan = getRootSpan(this._tracer)
    if (!topSpan) {
      return false
    }

    block({
      req: request,
      res: response,
      topSpan: topSpan
    })
    return true
  }

  setUser (user) {
    if (!user || !user.id) {
      return
    }

    const rootSpan = getRootSpan(this._tracer)
    if (!rootSpan) {
      return
    }

    this._setUser(user, rootSpan)
  }

  _setUser (user, rootSpan) {
    for (const k of Object.keys(user)) {
      rootSpan.setTag(`usr.${k}`, '' + user[k])
    }
  }
}

module.exports = AppsecSDK
