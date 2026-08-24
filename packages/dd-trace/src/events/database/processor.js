'use strict'

const { CLIENT_PORT_KEY } = require('../../constants')
const log = require('../../log')
const DatabasePlugin = require('../../plugins/database')
const TraceManager = require('../trace-manager')
const QueryLifecycleAdapter = require('./query-lifecycle-adapter')

const SQL_SYSTEMS = new Set(['mariadb', 'mssql', 'mysql', 'oracle', 'postgresql'])

class DatabaseProcessor extends DatabasePlugin {
  static id = 'database'
  static eventOperation = 'db.query'
  static peerServicePrecursors = ['db.name']
  static traceConnect = false

  #consumers = new WeakMap()
  #lifecycleAdapter
  #traceManager

  /**
   * Create the shared database processor for one tracer.
   *
   * @param {object} tracer Tracer instance.
   * @param {object} tracerConfig Global tracer configuration.
   */
  constructor (tracer, tracerConfig) {
    super(tracer, tracerConfig)

    this.#traceManager = new TraceManager(this)
    this.#lifecycleAdapter = new QueryLifecycleAdapter(this.#traceManager)
  }

  /**
   * Compile stable source policy and bind it to this processor.
   *
   * @param {object} runtime Per-tracer package source runtime.
   * @returns {object} Stable source consumer used by the process-wide bridge.
   */
  createSourceConsumer (runtime) {
    const existing = this.#consumers.get(runtime)
    if (existing) return existing

    const { identity } = runtime.adapter
    const integration = identity.integration || runtime.source
    const system = identity.system || integration
    const schema = identity.schema === undefined ? integration : identity.schema
    const sql = SQL_SYSTEMS.has(system)
    const policy = Object.freeze({
      component: identity.component || integration.replaceAll('-', '_'),
      integration,
      name: schema ? this.operationName({ id: schema }) : `${system}.query`,
      schema,
      sql,
      system,
      systemTag: sql ? 'db.type' : 'db.system',
      type: identity.spanType || (sql ? 'sql' : system),
    })

    const consumer = {
      complete: event => this.#complete(event),
      fail: event => this.#fail(event),
      start: event => this.#bindStart(event, runtime, policy, consumer),
    }

    Object.freeze(consumer)
    this.#consumers.set(runtime, consumer)
    return consumer
  }

  /**
   * Suppress the legacy automatic tracing-channel subscriptions.
   *
   * The processor registers only the semantic phases used by its fixed lifecycle adapters.
   *
   * @returns {void}
   */
  addTraceSubs () {}

  /**
   * Materialize a database span and apply processor-owned SQL write-back without exposing the span to package code.
   *
   * @param {string} name Resolved database operation name.
   * @param {object & {sourceUpdate?: object}} options Resolved database tracing options.
   * @param {object} context Source lifecycle context.
   * @returns {import('../../../../..').Span} Started database span.
   */
  startSpan (name, options, context) {
    const span = super.startSpan(name, options, context)
    const event = options.sourceUpdate
    if (!event) return span

    try {
      const serviceName = options.service !== null && typeof options.service === 'object'
        ? options.service.name
        : options.service
      const statement = event.facts.statement
      const updatedStatement = this.injectDbmQuery(span, statement, serviceName, false, options.config)
      if (updatedStatement !== statement) event.updates = { statement: updatedStatement }
    } catch (error) {
      log.error('Database source "%s" failed during query update: %s',
        options.integrationName, error?.message || error)
    }

    return span
  }

  /**
   * Normalize and start one database query operation.
   *
   * @param {object} event Package source lifecycle context.
   * @param {object} runtime Per-tracer package source runtime.
   * @param {object} policy Stable database source policy.
   * @param {object} consumer Stable source consumer starting the operation.
   * @returns {object | undefined} Store active while the package operation runs.
   */
  #bindStart (event, runtime, policy, consumer) {
    const source = policy.integration
    if (!runtime.enabled) return event.parentStore

    const { facts } = event
    if (!facts || facts.skip) return facts?.skip === 'noop' ? { noop: true } : event.parentStore

    try {
      const options = this.#createQueryOptions(runtime, policy, facts)
      if (policy.sql && runtime.adapter.supportsStatementUpdate && event.primaryConsumer === consumer &&
        typeof facts.statement === 'string') {
        options.sourceUpdate = event
      }
      this.#lifecycleAdapter.start(policy.name, options, event)
    } catch (error) {
      log.error('Database source "%s" failed to start tracing: %s', source, error?.message || error)
      return event.parentStore
    }

    return event.currentStore
  }

  /**
   * Record and finish a failed database query exactly once.
   *
   * @param {object & {error?: unknown}} event Package source lifecycle context.
   * @returns {void}
   */
  #fail (event) {
    try {
      this.#lifecycleAdapter.error(event, event.error, event.metadata)
    } catch (error) {
      log.error('Database query adapter failed during error: %s', error?.message || error)
    }
  }

  /**
   * Complete and finish a successful database query exactly once.
   *
   * @param {object} event Package source lifecycle context.
   * @returns {void}
   */
  #complete (event) {
    try {
      this.#lifecycleAdapter.complete(event, event.metadata)
    } catch (error) {
      log.error('Database query adapter failed during completion: %s', error?.message || error)
    }
  }

  /**
   * Build the dynamic database query tracing options from package facts and compiled source policy.
   *
   * @param {object} runtime Enabled package source runtime.
   * @param {object} policy Stable database source policy.
   * @param {object} facts Normalized query facts.
   * @returns {object} Resolved tracing options.
   */
  #createQueryOptions (runtime, policy, facts) {
    const config = runtime.config
    const { component, integration, schema, system, systemTag, type } = policy
    const connection = facts.connection || {}
    const service = schema
      ? this.serviceName({
        dbConfig: connection,
        id: schema,
        pluginConfig: config,
        system,
      })
      : resolveDefaultService(this.tracer, config, integration, connection)
    return {
      component,
      config,
      integrationName: integration,
      kind: 'client',
      meta: {
        component,
        [systemTag]: system,
        'db.user': connection.user,
        'db.name': connection.database,
        'out.host': connection.host,
        [CLIENT_PORT_KEY]: connection.port,
        ...facts.tags,
      },
      resource: facts.resource ?? facts.statement,
      service,
      type,
    }
  }
}

/**
 * Resolve storage-default service naming for sources without a schema entry.
 *
 * @param {object} tracer Tracer instance.
 * @param {Record<string, unknown>} config Package source configuration.
 * @param {string} integration Package integration identifier.
 * @param {object} connection Package connection configuration.
 * @returns {string | {name: string, source: string}} Resolved service name.
 */
function resolveDefaultService (tracer, config, integration, connection) {
  const configured = typeof config.service === 'function' ? config.service(connection) : config.service
  return configured || { name: `${tracer._service}-${integration}`, source: integration }
}

module.exports = DatabaseProcessor
