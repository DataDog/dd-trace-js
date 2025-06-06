'use strict'

const InboundPlugin = require('./inbound')

class ConsumerPlugin extends InboundPlugin {
  static get operation () { return 'receive' }
  static get kind () { return 'consumer' }
  static get type () { return 'messaging' }

  startSpan (options, enterOrCtx) {
    options.service ||= this.config.service || this.serviceName()
    options.kind ||= this.constructor.kind
    return super.startSpan(this.operationName(), options, enterOrCtx)
  }
}

module.exports = ConsumerPlugin
