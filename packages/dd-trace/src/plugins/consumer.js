'use strict'

const InboundPlugin = require('./inbound')

class ConsumerPlugin extends InboundPlugin {
  static operation = 'receive'
  static kind = 'consumer'
  static type = 'messaging'

  startSpan (name, options, enterOrCtx) {
    if (typeof name === 'object' && name !== null && enterOrCtx === undefined) {
      enterOrCtx = options
      options = name
      name = this.operationName()
    }

    if (!options.service) {
      options.service = this.config.service || this.serviceName()
    }
    if (!options.kind) {
      options.kind = this.constructor.kind
    }
    return super.startSpan(name, options, enterOrCtx)
  }
}

module.exports = ConsumerPlugin
