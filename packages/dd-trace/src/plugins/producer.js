'use strict'

const OutboundPlugin = require('./outbound')

class ProducerPlugin extends OutboundPlugin {
  static operation = 'publish'
  static kind = 'producer'
  static type = 'messaging'

  startSpan (options, enterOrCtx) {
    const spanDefaults = {
      kind: this.constructor.kind,
    }
    if (!options.service) {
      if (this.config.service) {
        options.service = this.config.service
        options.serviceSource = 'opt.plugin'
      } else {
        const { name, source } = this.serviceName()
        options.service = name
        options.serviceSource = () => source
      }
    }
    for (const key of Object.keys(spanDefaults)) {
      if (!options[key]) {
        options[key] = spanDefaults[key]
      }
    }

    return super.startSpan(this.operationName(), options, enterOrCtx)
  }
}

module.exports = ProducerPlugin
