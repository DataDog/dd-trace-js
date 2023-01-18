'use strict'

const { trackUserLoginSuccessEvent, trackUserLoginFailureEvent, trackCustomEvent } = require('./track_event')
const { isUserBlocked } = require('./user_blocking')
const Gateway = require('../gateway/engine')
const web = require('../../plugins/util/web')
const { block } = require('../blocking')

class AppsecSDK {
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

  isUserBlocked (user) {
    if (!user || !user.id) {
      return false
    }
    return isUserBlocked(this._tracer, user)
  }

  blockRequest (req, res, statusCode, body) {
    const request = req || Gateway.getContext().get('req')
    const response = res || Gateway.getContext().get('res')
    const topSpan = web.root(req)
    if (!topSpan) {
      return
    }

    block({
      req: request,
      res: response,
      statusCode: statusCode,
      body: body,
      topSpan: topSpan
    })
  }

  setUser (user) {
    const span = this._tracer.scope().active()
    if (!span) return

    const rootSpan = span._spanContext._trace.started[0]
    if (!rootSpan) return

    for (const k of Object.keys(user)) {
      rootSpan.setTag(`usr.${k}`, '' + user[k])
    }
  }
}

module.exports = AppsecSDK
