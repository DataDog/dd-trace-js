'use strict'

const { CLIENT_PORT_KEY } = require('../../constants')
const DatabasePlugin = require('../../plugins/database')

/**
 * Shared processor for normalized database query lifecycle events.
 *
 * Source adapters own package-specific argument and completion handling. This
 * processor owns Datadog query span semantics and DBM propagation.
 */
class DatabaseQueryProcessor extends DatabasePlugin {
  static prefix = 'tracing:datadog:db:query'
  static eventOperation = 'db.query'
  static traceConnect = false

  /**
   * @param {object} tracer Tracer instance.
   * @param {object} tracerConfig Global tracer configuration.
   * @param {import('../registry').EventDomainRegistry} registry Event domain registry.
   */
  constructor (tracer, tracerConfig, registry) {
    super(tracer, tracerConfig)
    this._registry = registry
  }

  /**
   * Subscribe only to semantic phases owned by the database processor.
   *
   * @returns {void}
   */
  addTraceSubs () {
    this.addTraceSub('error', this.error.bind(this))
    this.addTraceSub('finish', this.finish.bind(this))
    this.addTraceBind('start', this.bindStart.bind(this))
  }

  /**
   * Start a database span using configuration owned by the package source.
   *
   * @param {object} event Normalized database query event.
   * @returns {object|undefined} Store containing the started span.
   */
  bindStart (event) {
    const data = event.data
    const source = event.source
    const runtime = this._registry.getSource(this.constructor.eventOperation, source.integration)
    if (!runtime) return event.parentStore

    const config = runtime.config
    const system = source.system
    const connection = data.connection
    const service = this.serviceName({
      pluginConfig: config,
      dbConfig: connection,
      system,
      id: source.integration,
    })
    const span = this.startSpan(this.operationName({ id: source.integration }), {
      component: source.integration,
      integrationName: source.integration,
      service,
      resource: data.statement,
      type: 'sql',
      kind: 'client',
      meta: {
        'db.type': system,
        'db.user': connection.user,
        'db.name': connection.database,
        'out.host': connection.host,
        [CLIENT_PORT_KEY]: connection.port,
      },
      config,
    }, event)

    data.statement = this.injectDbmQuery(span, data.statement, service.name, false, config)

    return event.currentStore
  }
}

module.exports = DatabaseQueryProcessor
