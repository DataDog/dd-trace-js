'use strict'

const InboundPlugin = require('./inbound')

class ConsumerPlugin extends InboundPlugin {
  static operation = 'receive'
  static kind = 'consumer'
  static type = 'messaging'

  startSpan (options, enterOrCtx) {
    if (!options.service) {
      if (this.config.service) {
        options.service = this.config.service
        options.serviceSource = 'opt.plugin'
      } else {
        const { name, source } = this.serviceName()
        options.service = name
        options.serviceSource = source
      }
    }
    if (!options.kind) {
      options.kind = this.constructor.kind
    }
    return super.startSpan(this.operationName(), options, enterOrCtx)
  }
}

module.exports = ConsumerPlugin
