'use strict'

const OutboundPlugin = require('./outbound')

class ProducerPlugin extends OutboundPlugin {
  static get operation () { return 'publish' }
  static get kind () { return 'producer' }
  static get type () { return 'messaging' }

  startSpan (options, enterOrCtx) {
    const spanDefaults = {
      kind: this.constructor.kind
    }
    options.service ||= this.config.service || this.serviceName()
    for (const key of Object.keys(spanDefaults)) {
      options[key] ||= spanDefaults[key]
    }

    return super.startSpan(this.operationName(), options, enterOrCtx)
  }
}

module.exports = ProducerPlugin
