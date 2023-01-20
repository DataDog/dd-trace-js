'use strict'

const { trackUserLoginSuccessEvent, trackUserLoginFailureEvent, trackCustomEvent } = require('./track_event')
const { isUserBlocked } = require('./user_blocking')
const web = require('../../plugins/util/web')
const { block, loadTemplates } = require('../blocking')
const { getRootSpan } = require('./utils')
const als = require('../gateway/als')

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
      this.setUser({ id: user.id })
    }
    return isUserBlocked(user)
  }

  blockRequest (req, res) {
    const store = als.getStore()
    const request = req || store ? store.get('req') : undefined
    const response = res || store ? store.get('res') : undefined

    if (!request || !response) {
      return
    }
    const topSpan = web.root(request)
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
