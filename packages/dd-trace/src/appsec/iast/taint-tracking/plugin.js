'use strict'

const Plugin = require('../../../plugins/plugin')
const { getIastContext } = require('../iast-context')
const { storage } = require('../../../../../datadog-core')
const { taintObject } = require('./operations')
const {
  HTTP_REQUEST_PARAMETER,
  HTTP_REQUEST_BODY,
  HTTP_REQUEST_COOKIE_VALUE,
  HTTP_REQUEST_COOKIE_NAME
} = require('./origin-types')

class TaintTrackingPlugin extends Plugin {
  constructor () {
    super()
    this._type = 'taint-tracking'
    this.addSub(
      'datadog:body-parser:read:finish',
      ({ req }) => this._taintTrackingHandler(HTTP_REQUEST_BODY, req, 'body')
    )
    this.addSub(
      'datadog:qs:parse:finish',
      ({ qs }) => this._taintTrackingHandler(HTTP_REQUEST_PARAMETER, qs)
    )
    this.addSub(
      'datadog:cookie:parse:finish',
      ({ cookies }) => this._cookiesTaintTrackingHandler(cookies)
    )
  }

  _taintTrackingHandler (type, target, property) {
    const iastContext = getIastContext(storage.getStore())
    if (!property) {
      target = taintObject(iastContext, target, type)
    } else {
      target[property] = taintObject(iastContext, target[property], type)
    }
  }

  _cookiesTaintTrackingHandler (target) {
    const iastContext = getIastContext(storage.getStore())
    target = taintObject(iastContext, target, HTTP_REQUEST_COOKIE_VALUE, true, HTTP_REQUEST_COOKIE_NAME)
  }

  enable () {
    this.configure(true)
  }

  disable () {
    this.configure(false)
  }
}

module.exports = new TaintTrackingPlugin()
