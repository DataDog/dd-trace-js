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
        options.srvSrc = this.config.serviceFromMapping ? 'opt.mapping' : 'm'
      } else {
        const snOpts = {}
        options.service = this.serviceName(snOpts)
        options.srvSrc = snOpts.srvSrc
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
