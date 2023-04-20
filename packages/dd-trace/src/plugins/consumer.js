'use strict'

const InboundPlugin = require('./inbound')

class ConsumerPlugin extends InboundPlugin {
  static get operation () { return 'receive' }
  static get type () { return 'messaging' }

  startSpan (options) {
    const spanDefaults = {
      service: this.config.service || this.serviceName(),
      kind: 'consumer'
    }
    Object.keys(spanDefaults).forEach(
      key => {
        if (!options[key]) options[key] = spanDefaults[key]
      }
    )
    return super.startSpan(this.operationName(), options)
  }
}

module.exports = ConsumerPlugin
