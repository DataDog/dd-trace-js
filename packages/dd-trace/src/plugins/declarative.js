'use strict'

const TracingPlugin = require('./tracing')
const ProducerPlugin = require('./producer')
const ConsumerPlugin = require('./consumer')
const DatabasePlugin = require('./database')
const CompositePlugin = require('./composite')

const OPERATORS = {
  TRACE_SYNC: 'traceSync',
  TRACE_PROMISE: 'tracePromise',
  WRAP_CALLBACK: 'wrapCallback'
}

/**
 * A factory that creates a declarative plugin class.
 * @param {class} BasePlugin The semantic base plugin to extend (e.g., ConsumerPlugin).
 */
function createDeclarativePlugin (BasePlugin) {
  return class extends BasePlugin {
    constructor (...args) {
      super(...args)

      if (!this.constructor.analysis?.orchestrion_config?.instrumentations) {
        const pluginId = this.constructor.id || 'unknown'
        throw new Error(
          `DeclarativePlugin for ${pluginId} missing analysis.orchestrion_config.instrumentations`
        )
      }
      this.analysis = this.constructor.analysis

      this.extractionFunctions = this._compileExtractionFunctions()
      this.subscribe()
    }

    _compileExtractionFunctions () {
      const functions = {}
      for (const instrumentation of this.analysis.orchestrion_config.instrumentations) {
        if (instrumentation.role !== this.constructor.operation) continue

        const channelName = instrumentation.channel_name
        const contextCapture = instrumentation.context_capture || {}

        functions[channelName] = this._createExtractionFunction(contextCapture)
      }
      return functions
    }

    _createExtractionFunction (contextCapture) {
      const self = this
      return (ctx) => {
        const tags = {}
        // Normalize context: handle both {self, arguments} and {this, args} formats
        const normalizedCtx = {
          this: ctx.self || ctx.this,
          arguments: ctx.arguments || ctx.args
        }

        for (const [tagName, mapping] of Object.entries(contextCapture)) {
          try {
            tags[tagName] = mapping.startsWith("'") && mapping.endsWith("'")
              ? mapping.slice(1, -1) // Hardcoded value: 'bullmq' -> "bullmq"
              : self._getNestedValue(normalizedCtx, mapping) // Context path: "this.name" -> normalizedCtx.this.name
          } catch (e) {
            // Gracefully degrade: log error but continue extraction for other tags
            // eslint-disable-next-line no-console
            console.error(
              `[DeclarativePlugin] Failed to extract tag "${tagName}" using mapping "${mapping}":`,
              e.message
            )
          }
        }
        return tags
      }
    }

    _getNestedValue (obj, path) {
      return path.split('.').reduce((current, key) => current?.[key], obj)
    }

    subscribe () {
      const filteredTargets = this.analysis.orchestrion_config.instrumentations.filter(target => {
        if (!this.constructor.operation) return true // No filtering if role is not defined
        return target.role === this.constructor.operation
      })

      for (const target of filteredTargets) {
        this.addTraceBind('start', (ctx) => this.bindStart(ctx, target), target.channel_name)
        this.addTraceBind('error', (ctx) => this.error(ctx), target.channel_name)

        if (target.operator === OPERATORS.TRACE_SYNC) {
          this.addTraceBind('end', (ctx) => this.bindFinish(ctx), target.channel_name)
        } else if (target.operator === OPERATORS.TRACE_PROMISE || target.operator === OPERATORS.WRAP_CALLBACK) {
          this._subscribeAsyncOperator(target.channel_name)
        }
      }
    }

    _subscribeAsyncOperator (channelName) {
      const bindFinish = (ctx) => this.bindFinish(ctx)
      this.addTraceBind('end', bindFinish, channelName)
      this.addTraceBind('asyncEnd', bindFinish, channelName)
      this.addTraceBind('asyncStart', bindFinish, channelName)
      this.addTraceSub('end', bindFinish, channelName)
      this.addTraceSub('asyncEnd', bindFinish, channelName)
      this.addTraceSub('asyncStart', bindFinish, channelName)
    }

    bindStart (ctx, mapping) {
      try {
        const tags = this.extractionFunctions[mapping.channel_name](ctx)
        const methodName = mapping.function_query?.name || 'unknown'
        const name = `${this.analysis.package.name}.${methodName}`
        const options = {
          meta: tags,
          resource: tags['resource.name'] || methodName
        }

        return this.startSpan(name, options, ctx)
      } catch (error) {
        // Gracefully degrade: log error but don't crash the service
        // eslint-disable-next-line no-console
        console.error(`[DeclarativePlugin] Failed to create span for ${mapping.channel_name}:`, error.message)
        return ctx.parentStore
      }
    }

    bindFinish (ctx) {
      const span = ctx?.currentStore?.span
      if (span) {
        super.finish(ctx)
      }
      return ctx.parentStore
    }

    error (ctx) {
      const span = ctx?.currentStore?.span
      if (span) {
        span.setTag('error', ctx.error)
      }
      return ctx.parentStore
    }

    addTraceBind (eventName, transform, channelName) {
      this.addBind(`tracing:${channelName}:${eventName}`, transform)
    }

    addTraceSub (eventName, transform, channelName) {
      this.addSub(`tracing:${channelName}:${eventName}`, transform)
    }

    asyncEnd (ctx) {
      // eslint-disable-next-line no-console
      console.log(`[DeclarativePlugin] asyncEnd triggered for channel: ${ctx.channelName}`)
      return this.bindFinish(ctx)
    }

    asyncStart (ctx) {
      // eslint-disable-next-line no-console
      console.log(`[DeclarativePlugin] asyncStart triggered for channel: ${ctx.channelName}`)
      return this.bindFinish(ctx)
    }
  }
}

module.exports = {
  createDeclarativePlugin,
  DeclarativeTracingPlugin: createDeclarativePlugin(TracingPlugin),
  DeclarativeProducerPlugin: createDeclarativePlugin(ProducerPlugin),
  DeclarativeConsumerPlugin: createDeclarativePlugin(ConsumerPlugin),
  DeclarativeDatabasePlugin: createDeclarativePlugin(DatabasePlugin)
}

function createAutoConfiguredPlugin (dirname, integrationName) {
  const path = require('path')
  const analysis = require(path.join(dirname, `${integrationName}.analysis.json`))

  const id = analysis.package.name
  const roles = [...new Set(analysis.orchestrion_config.instrumentations.map(m => m.role))]

  if (roles.length === 0) {
    // We can decide to return a simple TracingPlugin or nothing in this case.
    // For now, let's assume a plugin is only created if there are roles.
    return class extends TracingPlugin {
      static get id () { return id }
    }
  }

  const roleToPluginMap = {
    producer: createDeclarativePlugin(ProducerPlugin),
    consumer: createDeclarativePlugin(ConsumerPlugin),
    database: createDeclarativePlugin(DatabasePlugin)
    // Add other roles here as they are developed
  }

  // If there's only one role, return a single plugin, not a composite.
  if (roles.length === 1) {
    const role = roles[0]
    const BasePlugin = roleToPluginMap[role] || createDeclarativePlugin(TracingPlugin)
    return class extends BasePlugin {
      static get id () { return id }
      static get operation () { return role }
      static get analysis () { return analysis }
    }
  }

  // If there are multiple roles, create a composite plugin.
  const childPlugins = {}
  for (const pluginRole of roles) {
    if (roleToPluginMap[pluginRole]) {
      const BasePlugin = roleToPluginMap[pluginRole]
      childPlugins[pluginRole] = ((role) => {
        return class extends BasePlugin {
          static get id () { return id }
          static get operation () { return role }
          static get analysis () { return analysis }
        }
      })(pluginRole)
    }
  }

  class AutoConfiguredPlugin extends CompositePlugin {
    static get id () {
      return id
    }

    static get plugins () {
      return childPlugins
    }
  }

  return AutoConfiguredPlugin
}

module.exports.createAutoConfiguredPlugin = createAutoConfiguredPlugin
