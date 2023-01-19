'use strict'

const { trackUserLoginSuccessEvent, trackUserLoginFailureEvent, trackCustomEvent } = require('./track_event')
const { isUserBlocked } = require('./user_blocking')
const Gateway = require('../gateway/engine')
const web = require('../../plugins/util/web')
const { block, loadTemplates } = require('../blocking')
const { getRootSpan } = require('./utils')

class AppsecSDK {
  constructor (tracer) {
    this._tracer = tracer
    loadTemplates(tracer.config)
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
    return isUserBlocked(this._tracer, user)
  }

  blockRequest (req, res) {
    const request = req || Gateway.getContext().get('req')
    const response = res || Gateway.getContext().get('res')
    const topSpan = web.root(req)
    if (!topSpan) {
      return
    }

    block({
      req: request,
      res: response,
      topSpan: topSpan
    })
  }

  setUser (user) {
    if (!user || !user.id) {
      return
    }

    const rootSpan = getRootSpan(this._tracer)
    if (!rootSpan) {
      return
    }

    for (const k of Object.keys(user)) {
      rootSpan.setTag(`usr.${k}`, '' + user[k])
    }
  }
}

module.exports = AppsecSDK
