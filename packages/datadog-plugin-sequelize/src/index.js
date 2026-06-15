'use strict'

const PoolAcquirePlugin = require('../../dd-trace/src/plugins/pool-acquire')

class SequelizePlugin extends PoolAcquirePlugin {
  static id = 'sequelize'
}

module.exports = SequelizePlugin
