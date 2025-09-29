'use strict'

const InboundPlugin = require('./inbound')

class ConsumerPlugin extends InboundPlugin {
  static operation = 'receive'
  static kind = 'consumer'
  static type = 'messaging'

  startSpan (name, options, enterOrCtx) {
    if (!options.service) {
      options.service = this.config.service || this.serviceName()
    }
    if (!options.kind) {
      options.kind = this.constructor.kind
    }
    return super.startSpan(this.operationName(), options, enterOrCtx)
  }
}

module.exports = ConsumerPlugin
