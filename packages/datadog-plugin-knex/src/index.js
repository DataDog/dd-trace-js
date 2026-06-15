'use strict'

const PoolAcquirePlugin = require('../../dd-trace/src/plugins/pool-acquire')

class KnexPlugin extends PoolAcquirePlugin {
  static id = 'knex'
}

module.exports = KnexPlugin
