'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const PoolAcquirePlugin = require('./pool-acquire')
const QueryPlugin = require('./query')

class OracledbPlugin extends CompositePlugin {
  static id = 'oracledb'

  static plugins = {
    query: QueryPlugin,
    poolAcquire: PoolAcquirePlugin,
  }

  /**
   * @override
   * @param {import('../../dd-trace/src/config/config-base') & { enabled: boolean }} config
   */
  configure (config) {
    // The query child is an implementation boundary, not a separate public option.
    const normalized = {
      ...config,
      query: undefined,
    }
    return super.configure(normalized)
  }
}

module.exports = OracledbPlugin
