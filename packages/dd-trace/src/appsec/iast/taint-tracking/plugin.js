'use strict'

const Plugin = require('../../../plugins/plugin')
const { getIastContext } = require('../iast-context')
const { storage } = require('../../../../../datadog-core')
const { taintObject } = require('./operations')
const {
  HTTP_REQUEST_PARAMETER,
  HTTP_REQUEST_BODY,
  HTTP_REQUEST_COOKIE_VALUE,
  HTTP_REQUEST_COOKIE_NAME,
  HTTP_REQUEST_HEADER_VALUE,
  HTTP_REQUEST_HEADER_NAME
} = require('./origin-types')

class TaintTrackingPlugin extends Plugin {
  constructor () {
    super()
    this._type = 'taint-tracking'
    this.addSub(
      'datadog:body-parser:read:finish',
      ({ req }) => {
        const iastContext = getIastContext(storage.getStore())
        if (iastContext && iastContext['body'] !== req.body) {
          this._taintTrackingHandler(HTTP_REQUEST_BODY, req, 'body', iastContext)
          iastContext['body'] = req.body
        }
      }
    )
    this.addSub(
      'datadog:qs:parse:finish',
      ({ qs }) => this._taintTrackingHandler(HTTP_REQUEST_PARAMETER, qs)
    )
    this.addSub('apm:express:middleware:next', ({ req }) => {
      if (req && req.body && typeof req.body === 'object') {
        const iastContext = getIastContext(storage.getStore())
        if (iastContext && iastContext['body'] !== req.body) {
          this._taintTrackingHandler(HTTP_REQUEST_BODY, req, 'body', iastContext)
          iastContext['body'] = req.body
        }
      }
    })
    this.addSub(
      'datadog:cookie:parse:finish',
      ({ cookies }) => this._cookiesTaintTrackingHandler(cookies)
    )
  }

  _taintTrackingHandler (type, target, property, iastContext = getIastContext(storage.getStore())) {
    if (!property) {
      taintObject(iastContext, target, type)
    } else if (target[property]) {
      target[property] = taintObject(iastContext, target[property], type)
    }
  }

  _cookiesTaintTrackingHandler (target) {
    const iastContext = getIastContext(storage.getStore())
    taintObject(iastContext, target, HTTP_REQUEST_COOKIE_VALUE, true, HTTP_REQUEST_COOKIE_NAME)
  }

  taintHeaders (headers) {
    const iastContext = getIastContext(storage.getStore())
    taintObject(iastContext, headers, HTTP_REQUEST_HEADER_VALUE, true, HTTP_REQUEST_HEADER_NAME)
  }

  enable () {
    this.configure(true)
  }

  disable () {
    this.configure(false)
  }
}

module.exports = new TaintTrackingPlugin()
