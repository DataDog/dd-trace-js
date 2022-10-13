'use strict'

const IncomingPlugin = require('./incoming')

class ConsumerPlugin extends IncomingPlugin {
  static get operation () { return 'receive' }
}

module.exports = ConsumerPlugin
