'use strict'

const OutboundPlugin = require('./outbound')

class ProducerPlugin extends OutboundPlugin {
  static get operation () { return 'publish' }
  static get kind () { return 'producer' }
  static get type () { return 'messaging' }

  startSpan (options) {
    const spanDefaults = {
      service: this.config.service || this.serviceName(),
      kind: this.constructor.kind
    }
    Object.keys(spanDefaults).forEach(
      key => {
        if (!options[key]) options[key] = spanDefaults[key]
      }
    )
    return super.startSpan(this.operationName(), options)
  }
}

module.exports = ProducerPlugin
