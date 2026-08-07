'use strict'

const { DatabaseQueryProcessor } = require('../../dd-trace/src/events/database')
const { getEventDomainRegistry } = require('../../dd-trace/src/events/registry')
const {
  MYSQL_SOURCE,
  mysqlAdapter,
  sourceRegistry,
} = require('./source-adapter')

class MysqlEventIntegration {
  static id = 'mysql'

  /**
   * @param {object} tracer Tracer instance.
   * @param {object} tracerConfig Global tracer configuration.
   */
  constructor (tracer, tracerConfig) {
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
   * @param {object} tracerConfig Global tracer configuration.
   * @param {boolean|object} integrationConfig MySQL integration configuration.
   * @returns {void}
   */
  configure (tracerConfig, integrationConfig) {
    const config = getMysqlConfig(tracerConfig, integrationConfig)
    const enabled = typeof config === 'boolean' ? config : config?.enabled !== false
    const operation = DatabaseQueryProcessor.eventOperation
    const source = MYSQL_SOURCE.integration
    this._enabled = enabled

    if (enabled) {
      this._registry.configureSource(operation, source, config)
      sourceRegistry.acquireSource(operation, source, this)
    } else {
      sourceRegistry.releaseSource(operation, source, this)
      this._registry.configureSource(operation, source, config)
    }
  }
}

function getMysqlConfig (tracerConfig, integrationConfig) {
  const config = typeof integrationConfig === 'boolean'
    ? { enabled: integrationConfig }
    : integrationConfig

  return {
    ...(tracerConfig.codeOriginForSpans ? { codeOriginForSpans: tracerConfig.codeOriginForSpans } : undefined),
    dbmPropagationMode: tracerConfig.dbmPropagationMode,
    ...(tracerConfig.serviceMapping?.mysql ? { service: tracerConfig.serviceMapping.mysql } : undefined),
    ...config,
  }
}

module.exports = MysqlEventIntegration
