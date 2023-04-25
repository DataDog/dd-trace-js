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
  HTTP_REQUEST_PATH_PARAM,
  HTTP_REQUEST_HEADER_VALUE,
  HTTP_REQUEST_HEADER_NAME
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
    this.addSub(
      'apm:express:middleware:enter',
      ({ req }) => this._taintTrackingHandler(HTTP_REQUEST_PATH_PARAM, req, 'params')
    )
  }

  _taintTrackingHandler (type, target, property) {
    const iastContext = getIastContext(storage.getStore())
    if (!target) return
    if (!property) {
      target = taintObject(iastContext, target, type)
    } else if (target[property]) {
      target[property] = taintObject(iastContext, target[property], type)
    }
  }

  _cookiesTaintTrackingHandler (target) {
    const iastContext = getIastContext(storage.getStore())
    target = taintObject(iastContext, target, HTTP_REQUEST_COOKIE_VALUE, true, HTTP_REQUEST_COOKIE_NAME)
  }

  taintHeaders (headers) {
    const iastContext = getIastContext(storage.getStore())
    headers = taintObject(iastContext, headers, HTTP_REQUEST_HEADER_VALUE, true, HTTP_REQUEST_HEADER_NAME)
  }

  enable () {
    this.configure(true)
  }

  disable () {
    this.configure(false)
  }
}

module.exports = new TaintTrackingPlugin()
