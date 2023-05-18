'use strict'

const OutboundPlugin = require('./outbound')

class ProducerPlugin extends OutboundPlugin {
  static get operation () { return 'publish' }
  static get kind () { return 'producer' }
  static get type () { return 'messaging' }

  startSpan (options) {
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
    return super.startSpan(this.operationName(), options)
  }
}

module.exports = ProducerPlugin
