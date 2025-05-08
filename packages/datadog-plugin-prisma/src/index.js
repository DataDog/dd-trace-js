'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')

const PrismaCLientPlugin = require('./client')
const PrismaEnginePlugin = require('./engine')

class PrismaPlugin extends CompositePlugin {
  static get id () { return 'prisma' }
  static get plugins () {
    return {
      client: PrismaCLientPlugin,
      engine: PrismaEnginePlugin
    }
  }

  configure (config) {
    return super.configure(config)
  }
}

module.exports = PrismaPlugin
