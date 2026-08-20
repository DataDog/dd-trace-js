'use strict'

const { storage } = require('../../../../datadog-core')

const { CLIENT_PORT_KEY } = require('../../constants')
const log = require('../../log')
const DatabasePlugin = require('../../plugins/database')
const TraceManager = require('../trace-manager')
const { queryError, queryFinish, queryStart } = require('./channels')
const QueryLifecycleAdapter = require('./query-lifecycle-adapter')

const legacyStorage = storage('legacy')
const SQL_SYSTEMS = new Set(['mariadb', 'mssql', 'mysql', 'oracle', 'postgresql'])

class DatabaseProcessor extends DatabasePlugin {
  static id = 'database'
  static eventOperation = 'db.query'
  static peerServicePrecursors = ['db.name']
  static traceConnect = false

  #lifecycleAdapter = new QueryLifecycleAdapter()
  #registry
  #states = new WeakMap()
  #traceManager

  /**
   * Create the shared database processor for one tracer.
   *
   * @param {object} tracer Tracer instance.
   * @param {object} tracerConfig Global tracer configuration.
   * @param {import('../registry').EventDomainRegistry} registry Event domain registry.
   */
  constructor (tracer, tracerConfig, registry) {
    super(tracer, tracerConfig)

    this.#registry = registry
    this.#traceManager = new TraceManager(this)
    this.addBind(queryStart.name, event => this.bindStart(event), { allowNoop: true })
    this.addSub(queryError.name, event => this.fail(event), { allowNoop: true })
    this.addSub(queryFinish.name, event => this.complete(event), { allowNoop: true })
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
   * Normalize and start one database query operation.
   *
   * @param {object} event Package source lifecycle context.
   * @returns {object | undefined} Store active while the package operation runs.
   */
  bindStart (event) {
    if (!Object.hasOwn(event, 'parentStore')) event.parentStore = legacyStorage.getStore()

    const source = event.source?.integration
    const runtime = this.#registry.getSource(this.constructor.eventOperation, source)
    if (!runtime) return event.parentStore

    let facts
    try {
      facts = runtime.adapter.start(event)
    } catch (error) {
      log.error('Database source "%s" failed during start: %s', source, error?.message || error)
      return event.parentStore
    }

    if (!facts || facts.skip) return facts?.skip === 'noop' ? { noop: true } : event.parentStore

    let token
    try {
      token = this.#lifecycleAdapter.start({
        context: event,
        facts,
        plan: this.#createQueryPlan(runtime, facts),
        traceManager: this.#traceManager,
      })
    } catch (error) {
      log.error('Database source "%s" failed to start tracing: %s', source, error?.message || error)
      return event.parentStore
    }

    this.#states.set(event, { runtime, token })
    if (runtime.adapter.updateSource) {
      try {
        runtime.adapter.updateSource(event, token.facts)
      } catch (error) {
        log.error('Database source "%s" failed during source update: %s', source, error?.message || error)
      }
    }

    return event.currentStore
  }

  /**
   * Record and finish a failed database query exactly once.
   *
   * @param {object & {error?: unknown}} event Package source lifecycle context.
   * @returns {void}
   */
  fail (event) {
    const state = this.#states.get(event)
    if (!state) return

    this.#states.delete(event)
    const metadata = this.#completeSource(state.runtime, event)
    try {
      this.#lifecycleAdapter.error(state.token, event.error, metadata)
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
  complete (event) {
    const state = this.#states.get(event)
    if (!state) return

    this.#states.delete(event)
    const metadata = this.#completeSource(state.runtime, event)
    try {
      this.#lifecycleAdapter.complete(state.token, metadata)
    } catch (error) {
      log.error('Database query adapter failed during completion: %s', error?.message || error)
    }
  }

  /**
   * Build the shared database query telemetry plan from package facts.
   *
   * @param {object} runtime Enabled package source runtime.
   * @param {object} facts Normalized query facts.
   * @returns {{name: string, options: object}} Resolved trace plan.
   */
  #createQueryPlan (runtime, facts) {
    const { identity } = runtime.adapter
    const config = runtime.config
    const integration = identity.integration || runtime.source
    const system = identity.system || integration
    const component = identity.component || integration.replaceAll('-', '_')
    const connection = facts.connection || {}
    const schema = identity.schema === undefined ? integration : identity.schema
    const service = schema
      ? this.serviceName({
        dbConfig: connection,
        id: schema,
        pluginConfig: config,
        system,
      })
      : resolveDefaultService(this.tracer, config, integration, connection)
    const name = schema
      ? this.operationName({ id: schema })
      : `${system}.query`

    return {
      name,
      options: {
        component,
        config,
        integrationName: integration,
        kind: 'client',
        meta: {
          component,
          'db.system': system,
          'db.user': connection.user,
          'db.name': connection.database,
          'out.host': connection.host,
          [CLIENT_PORT_KEY]: connection.port,
          ...facts.tags,
        },
        resource: facts.resource ?? facts.statement,
        service,
        type: identity.spanType || (SQL_SYSTEMS.has(system) ? 'sql' : system),
      },
    }
  }

  /**
   * Extract completion metadata without allowing package code to break finalization.
   *
   * @param {object} runtime Enabled package source runtime.
   * @param {object} event Package source lifecycle context.
   * @returns {Record<string, unknown> | undefined} Completion tags and metrics.
   */
  #completeSource (runtime, event) {
    if (!runtime.adapter.complete) return
    try {
      return runtime.adapter.complete(event)
    } catch (error) {
      log.error('Database source "%s" failed during completion: %s', runtime.source, error?.message || error)
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
