'use strict'

const { DatabaseQueryProcessor } = require('../../dd-trace/src/events/database')
const { getEventDomainRegistry } = require('../../dd-trace/src/events/registry')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const connectionPlugins = require('./connection')
const {
  MARIADB_SOURCE,
  mariadbAdapter,
  sourceRegistry,
} = require('./query')

const [
  CreateConnectionPlugin,
  CreatePoolPlugin,
  PoolGetConnectionPlugin,
  PoolCreateConnectionPlugin,
  V2ConnectionPlugin,
  V2PoolBasePlugin,
  V2PoolBaseGetConnectionPlugin,
] = connectionPlugins

class MariadbPlugin extends CompositePlugin {
  static id = 'mariadb'
  static plugins = {
    createConnection: CreateConnectionPlugin,
    createPool: CreatePoolPlugin,
    poolGetConnection: PoolGetConnectionPlugin,
    poolCreateConnection: PoolCreateConnectionPlugin,
    v2Connection: V2ConnectionPlugin,
    v2PoolBase: V2PoolBasePlugin,
    v2PoolGetConnection: V2PoolBaseGetConnectionPlugin,
  }

  /**
   * @param {object} tracer Tracer instance.
   * @param {object} tracerConfig Global tracer configuration.
   */
  constructor (tracer, tracerConfig) {
    super(tracer, tracerConfig)

    this._registry = getEventDomainRegistry(tracer, tracerConfig)
    this._registry.registerProcessor({
      operation: DatabaseQueryProcessor.eventOperation,
      Processor: DatabaseQueryProcessor,
    })
    this._registry.registerSource({
      operation: DatabaseQueryProcessor.eventOperation,
      source: MARIADB_SOURCE.integration,
      adapter: mariadbAdapter,
    })
  }

  /**
   * Configure MariaDB processing while sharing one database span processor.
   *
   * @param {boolean|object} config MariaDB plugin configuration.
   * @returns {void}
   */
  configure (config) {
    const enabled = typeof config === 'boolean' ? config : config?.enabled !== false
    const operation = DatabaseQueryProcessor.eventOperation
    const source = MARIADB_SOURCE.integration

    if (enabled) {
      this._registry.configureSource(operation, source, config)
      sourceRegistry.acquireSource(operation, source, this)
    } else {
      sourceRegistry.releaseSource(operation, source, this)
      this._registry.configureSource(operation, source, config)
    }

    super.configure(config)
  }
}

module.exports = MariadbPlugin
