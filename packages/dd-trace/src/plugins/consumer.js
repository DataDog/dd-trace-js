'use strict'

const InboundPlugin = require('./inbound')

class ConsumerPlugin extends InboundPlugin {
  static get operation () { return 'receive' }
  static get type () { return 'messaging' }
}

module.exports = ConsumerPlugin
