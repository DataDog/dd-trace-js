'use strict'

const { HTTP_REQUEST_PARAMETER, HTTP_REQUEST_BODY } = require('./source-types')
const { taintObject } = require('./operations')
const { SourceIastPlugin } = require('../iast-plugin')
const { getIastContext } = require('../iast-context')
const { storage } = require('../../../../../datadog-core')

class TaintTrackingPlugin extends SourceIastPlugin {
  constructor () {
    super()
    this._type = 'taint-tracking'
  }

  onConfigure () {
    this.addSub(
      { channelName: 'datadog:body-parser:read:finish', tag: HTTP_REQUEST_BODY },
      ({ req }) => this._taintTrackingHandler(HTTP_REQUEST_BODY, req, 'body')
    )
    this.addSub(
      { channelName: 'datadog:qs:parse:finish', tag: HTTP_REQUEST_PARAMETER },
      ({ qs }) => this._taintTrackingHandler(HTTP_REQUEST_PARAMETER, qs, null))
  }

  _taintTrackingHandler (type, target, property) {
    const iastContext = getIastContext(storage.getStore())
    if (!property) {
      target = taintObject(iastContext, target, type)
    } else {
      target[property] = taintObject(iastContext, target[property], type)
    }
  }

  enable () {
    this.configure(true)
  }

  disable () {
    this.configure(false)
  }
}

module.exports = new TaintTrackingPlugin()
