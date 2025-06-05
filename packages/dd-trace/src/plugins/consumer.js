'use strict'

const InboundPlugin = require('./inbound')

class ConsumerPlugin extends InboundPlugin {
  static get operation () { return 'receive' }
  static get kind () { return 'consumer' }
  static get type () { return 'messaging' }

  startSpan (options, enterOrCtx) {
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
