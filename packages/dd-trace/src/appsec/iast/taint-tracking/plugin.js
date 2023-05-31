'use strict'

const Plugin = require('../../../plugins/plugin')
const { getIastContext } = require('../iast-context')
const { storage } = require('../../../../../datadog-core')
const { HTTP_REQUEST_PARAMETER, HTTP_REQUEST_BODY } = require('./origin-types')
const { taintObject } = require('./operations')

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
      ({ qs }) => this._taintTrackingHandler(HTTP_REQUEST_PARAMETER, qs))

    this.addSub('apm:express:middleware:next', ({ req }) => {
      if (req && req.body && typeof req.body === 'object') {
        const iastContext = getIastContext(storage.getStore())
        if (iastContext && iastContext['body'] !== req.body) {
          this._taintTrackingHandler(HTTP_REQUEST_BODY, req, 'body', iastContext)
          iastContext['body'] = req.body
        }
      }
    })
  }

  _taintTrackingHandler (type, target, property, iastContext = getIastContext(storage.getStore())) {
    if (!property) {
      taintObject(iastContext, target, type)
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
