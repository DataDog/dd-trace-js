'use strict'

const OutboundPlugin = require('./outbound')

class ProducerPlugin extends OutboundPlugin {
  static operation = 'publish'
  static kind = 'producer'
  static type = 'messaging'

  startSpan (options, enterOrCtx) {
    const spanDefaults = {
      kind: this.constructor.kind
    }
    if (!options.service) {
      options.service = this.config.service || this.serviceName()
    }
    Object.keys(spanDefaults).forEach(
      key => {
        if (!options[key]) options[key] = spanDefaults[key]
      }
    )
    return super.startSpan(this.operationName(), options, enterOrCtx)
  }
}

module.exports = ProducerPlugin
