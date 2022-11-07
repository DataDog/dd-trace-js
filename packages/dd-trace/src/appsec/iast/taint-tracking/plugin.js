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
      'datadog:body-parser:read:start',
      ({ request }) => this._taintTrackingHandler(HTTP_REQUEST_BODY, request, 'body')
    )
    this.addSub(
      'datadog:qs:parse:start',
      ({ qs }) => this._taintTrackingHandler(HTTP_REQUEST_PARAMETER, qs))
  }

  _taintTrackingHandler (type, target, property) {
    const iastContext = getIastContext(storage.getStore())
    if (!property) {
      const taintedTarget = taintObject(iastContext, target, type)
      Object.defineProperties(
        target,
        { value: taintedTarget }
      )
    } else {
      const taintedTarget = taintObject(iastContext, target[property], type)
      Object.defineProperties(
        target[property],
        {
          value: taintedTarget
        }
      )
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
