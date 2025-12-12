'use strict'

const OutboundPlugin = require('./outbound')

class ProducerPlugin extends OutboundPlugin {
  static operation = 'publish'
  static kind = 'producer'
  static type = 'messaging'

  startSpan (name, options, enterOrCtx) {
    if (typeof name === 'object' && name !== null && enterOrCtx === undefined) {
      enterOrCtx = options
      options = name
      name = this.operationName()
    }

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
    return super.startSpan(name, options, enterOrCtx)
  }
}

module.exports = ProducerPlugin
