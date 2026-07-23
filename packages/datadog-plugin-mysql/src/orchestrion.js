'use strict'

const { DatabaseQueryProcessor } = require('../../dd-trace/src/events/database')
const { getEventDomainRegistry } = require('../../dd-trace/src/events/registry')
const Plugin = require('../../dd-trace/src/plugins/plugin')
const {
  MYSQL_SOURCE,
  mysqlAdapter,
  sourceRegistry,
} = require('./source-adapter')

class MysqlOrchestrionPlugin extends Plugin {
  static id = 'mysql'

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
      source: MYSQL_SOURCE.integration,
      adapter: mysqlAdapter,
    })
  }

  /**
   * Configure MySQL processing without creating package-specific span subscribers.
   *
   * @param {boolean|object} config MySQL plugin configuration.
   * @returns {void}
   */
  configure (config) {
    const enabled = typeof config === 'boolean' ? config : config?.enabled !== false
    const operation = DatabaseQueryProcessor.eventOperation
    const source = MYSQL_SOURCE.integration

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

module.exports = MysqlOrchestrionPlugin
