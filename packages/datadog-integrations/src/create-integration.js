'use strict'

const CachePlugin = require('../../dd-trace/src/plugins/cache')
const ClientPlugin = require('../../dd-trace/src/plugins/client')
const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const OutboundPlugin = require('../../dd-trace/src/plugins/outbound')
const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const ServerPlugin = require('../../dd-trace/src/plugins/server')
const StoragePlugin = require('../../dd-trace/src/plugins/storage')
const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

const BASE_CLASSES = {
  cache: CachePlugin,
  client: ClientPlugin,
  consumer: ConsumerPlugin,
  database: DatabasePlugin,
  producer: ProducerPlugin,
  server: ServerPlugin,
  storage: StoragePlugin,
  tracing: TracingPlugin,
}

// CachePlugin, ConsumerPlugin, and ProducerPlugin override startSpan with a 2-arg signature
// (options, ctx) that derives the operation name internally. The generated plugin needs the 3-arg
// signature (name, options, ctx). For each, we override startSpan to restore the name parameter
// and delegate to the nearest ancestor with a 3-arg signature, preserving the full chain
// (code origin tags, system-based service naming, etc.).
const STARTSPAN_ANCESTOR = {
  cache: StoragePlugin,     // StoragePlugin.startSpan(name, options, ctx) — adds system service naming
  consumer: TracingPlugin,  // InboundPlugin doesn't override startSpan
  producer: OutboundPlugin, // OutboundPlugin.startSpan(name, options, ctx) — adds code origin tags
}

const VALID_KINDS = new Set(['Sync', 'Async', 'AsyncIterator', 'Callback', 'Iterator'])

/**
 * @typedef {Object} OrchestrionEntry
 * @property {{ name: string, versionRange: string, filePath?: string }} module
 * @property {{ kind: string, className?: string, methodName?: string, index?: number }} functionQuery
 * @property {string} channelName
 * @property {string} [astQuery]
 */

/**
 * @typedef {Object} HookEntry
 * @property {string} name
 * @property {string[]} versions
 * @property {string} [file]
 */

/**
 * @typedef {Object} SpanConfig
 * @property {string|function(Object): string} name - Span operation name, or a function receiving ctx.
 * @property {'server'|'client'|'consumer'|'producer'|'internal'} spanKind - OpenTelemetry span kind.
 * @property {string|function(Object): string} [resource] - Resource name, or a function receiving ctx.
 * @property {Object|function(Object): Object} [attributes] - Span tags, or a function receiving ctx.
 * @property {string|function(this: TracingPlugin, Object): string} [service] - Service name override,
 *   or a function receiving ctx with `this` bound to the plugin instance.
 * @property {string} [type] - Span type (e.g. 'web', 'sql').
 * @property {function(this: TracingPlugin, Object): void} [prepare] - Called before span creation
 *   in bindStart. Receives ctx with `this` bound to the plugin instance. Use to enrich ctx with
 *   derived data (e.g. from ctx.self, ctx.arguments) that resource/attributes/name can reference.
 * @property {function(this: TracingPlugin, Object, Span): void} [onStart] - Called after span creation.
 *   Receives (ctx, span) with `this` bound to the plugin instance.
 * @property {function(this: TracingPlugin, Object, Span): void} [onFinish] - Called before span finish.
 *   Receives (ctx, span) with `this` bound to the plugin instance.
 */

/**
 * @typedef {Object} InterceptConfig
 * @property {string} [className] - The class name containing the method (for ES6 class patterns).
 * @property {string} [methodName] - The method name to instrument.
 * @property {string} [astQuery] - ESQuery selector for matching AST nodes (alternative to className/methodName).
 * @property {string} [channelName] - Explicit channel name (required when using astQuery).
 * @property {'Sync'|'Async'|'AsyncIterator'|'Callback'|'Iterator'} kind - The function's async pattern.
 * @property {number} [index] - Zero-based callback argument index. Supports negative indices (e.g. -1 for
 *   last argument). Required for Callback kind.
 * @property {string} [versions] - Semver range override for this intercept's orchestrion and hook entries.
 * @property {string|string[]} [file] - File path override for this intercept's orchestrion and hook entries.
 * @property {SpanConfig} span - The span to produce when this interception fires.
 */

/**
 * The `ctx` object passed to all SpanConfig functions is provided by orchestrion's TracingChannel
 * and includes:
 * - `ctx.self` — the `this` value of the instrumented method
 * - `ctx.arguments` — the method's arguments (mutable: changes are seen by the original method)
 * - `ctx.result` — the return value (available in onFinish/asyncEnd only)
 * - `ctx.config` — the plugin's config object (set by the generated bindStart)
 * - `ctx.currentStore` — the current async store (available after startSpan)
 * - `ctx.parentStore` — the parent async store
 * Any additional properties stashed on ctx in `prepare` or `onStart` persist through the
 * full TracingChannel lifecycle (asyncStart, asyncEnd, error).
 */

/**
 * @typedef {Object} IntegrationConfig
 * @property {string} id - The integration identifier used in channels, span names, and telemetry.
 * @property {string} module - The npm package name to instrument.
 * @property {string} versions - Semver range of supported versions.
 * @property {string|string[]} [file] - Path(s) to specific files within the package to instrument.
 * @property {'cache'|'client'|'consumer'|'database'|'producer'|'server'|'storage'|'tracing'} [type='tracing'] -
 *   The plugin base class type. This determines the tracing plugin superclass, which controls service
 *   naming, span tag defaults, and analytics behavior. Independent of `spanKind` — for example, a
 *   `database` type typically uses `spanKind: 'client'` because DB calls are outbound.
 * @property {string} [system] - System name for service naming (e.g. 'redis', 'mysql'). Only has an
 *   effect when the type is 'database' or 'storage'.
 * @property {InterceptConfig[]} intercepts - Function interception points, each defining an Orchestrion
 *   instrumentation site (the pointcut) and the span to produce when it fires (the advice).
 */

/**
 * Create a new integration from a declarative config object.
 *
 * @param {IntegrationConfig} config
 * @returns {{ orchestrion: OrchestrionEntry[], plugin: typeof TracingPlugin | typeof CompositePlugin, hooks: HookEntry[] }}
 */
function createIntegration (config) {
  const { id, module: moduleName, versions, type = 'tracing', system, intercepts } = config

  if (!id || typeof id !== 'string') {
    throw new Error('createIntegration() requires a non-empty string id')
  }

  if (!moduleName || typeof moduleName !== 'string') {
    throw new Error('createIntegration() requires a non-empty string module')
  }

  if (!Array.isArray(intercepts) || intercepts.length === 0) {
    throw new Error('createIntegration() requires at least one intercept')
  }

  const BaseClass = BASE_CLASSES[type]
  if (!BaseClass) {
    throw new Error(
      `Unknown plugin type: ${type}. Valid types: ${Object.keys(BASE_CLASSES).join(', ')}`
    )
  }

  const filePaths = config.file
    ? [config.file].flat()
    : [undefined]

  const orchestrion = []
  const pluginClasses = {}

  const hookMap = new Map()

  for (const intercept of intercepts) {
    if (!intercept.span) {
      throw new Error('each intercept requires a span configuration')
    }

    if (!VALID_KINDS.has(intercept.kind)) {
      throw new Error(
        `Invalid method kind "${intercept.kind}". Valid kinds: ${[...VALID_KINDS].join(', ')}`
      )
    }

    const channelName = intercept.channelName || (intercept.className
      ? `${intercept.className}_${intercept.methodName}`
      : intercept.methodName)

    if (!channelName) {
      throw new Error('channelName must be provided when using astQuery, or className/methodName must be set')
    }

    const effectiveVersions = intercept.versions ?? versions
    const effectiveFilePaths = intercept.file
      ? [intercept.file].flat()
      : filePaths

    for (const f of effectiveFilePaths) {
      const key = `${moduleName}:${effectiveVersions}:${f ?? ''}`
      if (!hookMap.has(key)) {
        const hook = { name: moduleName, versions: [effectiveVersions] }
        if (f) hook.file = f
        hookMap.set(key, hook)
      }
    }

    for (const filePath of effectiveFilePaths) {
      const entry = {
        module: {
          name: moduleName,
          versionRange: effectiveVersions,
        },
        functionQuery: {
          kind: intercept.kind,
        },
        channelName,
      }

      if (intercept.astQuery) {
        entry.astQuery = intercept.astQuery
      } else {
        entry.functionQuery.className = intercept.className
        entry.functionQuery.methodName = intercept.methodName
      }

      if (filePath) {
        entry.module.filePath = filePath
      }

      if (intercept.index !== undefined) {
        entry.functionQuery.index = intercept.index
      }

      orchestrion.push(entry)
    }

    pluginClasses[channelName] = createPluginClass(id, moduleName, system, type, channelName, intercept.span)
  }

  const hooks = [...hookMap.values()]

  const pluginKeys = Object.keys(pluginClasses)
  let plugin
  if (pluginKeys.length === 1) {
    plugin = pluginClasses[pluginKeys[0]]
  } else {
    plugin = class extends CompositePlugin {
      static id = id
      static plugins = pluginClasses
    }
  }

  return { orchestrion, plugin, hooks }
}

/**
 * @param {string} id
 * @param {string} moduleName
 * @param {string} [system]
 * @param {string} type
 * @param {string} channelName
 * @param {SpanConfig} spanConfig
 * @returns {typeof TracingPlugin}
 */
function createPluginClass (id, moduleName, system, type, channelName, spanConfig) {
  const prefix = `tracing:orchestrion:${moduleName}:${channelName}`
  const BaseClass = BASE_CLASSES[type]

  const GeneratedPlugin = class extends BaseClass {
    static id = id
    static prefix = prefix

    bindStart (ctx) {
      ctx.config = this.config

      if (spanConfig.prepare) {
        spanConfig.prepare.call(this, ctx)
      }

      const name = typeof spanConfig.name === 'function'
        ? spanConfig.name(ctx)
        : spanConfig.name

      const resource = typeof spanConfig.resource === 'function'
        ? spanConfig.resource(ctx)
        : spanConfig.resource

      const attributes = typeof spanConfig.attributes === 'function'
        ? spanConfig.attributes(ctx)
        : (spanConfig.attributes || {})

      const options = {
        kind: spanConfig.spanKind,
        meta: attributes,
      }

      if (resource !== undefined) {
        options.resource = resource
      }

      if (this.config.service) {
        options.service = this.config.service
      } else if (spanConfig.service) {
        options.service = typeof spanConfig.service === 'function'
          ? spanConfig.service.call(this, ctx)
          : spanConfig.service
      }

      if (spanConfig.type) {
        options.type = spanConfig.type
      }

      const span = this.startSpan(name, options, ctx)

      if (spanConfig.onStart) {
        spanConfig.onStart.call(this, ctx, span)
      }

      return ctx.currentStore
    }

    bindAsyncStart (ctx) {
      return ctx.parentStore
    }

    asyncEnd (ctx) {
      const span = ctx.currentStore?.span
      if (!span) return

      try {
        if (spanConfig.onFinish) {
          spanConfig.onFinish.call(this, ctx, span)
        }
      } finally {
        span.finish()
      }
    }

    bindAsyncEnd (ctx) {
      return ctx.parentStore
    }
  }

  if (system) {
    GeneratedPlugin.system = system
  }

  // CachePlugin, ConsumerPlugin, and ProducerPlugin override startSpan with a 2-arg signature
  // that derives the span name internally. Restore the 3-arg signature by applying the defaults
  // the 2-arg version would have applied, then delegating to the nearest 3-arg ancestor.
  const ancestor = STARTSPAN_ANCESTOR[type]
  if (ancestor) {
    GeneratedPlugin.prototype.startSpan = function startSpan (name, options, ctx) {
      if (!options.kind) options.kind = this.constructor.kind
      if (!options.service) options.service = this.config?.service || this.serviceName()
      return ancestor.prototype.startSpan.call(this, name, options, ctx)
    }
  }

  return GeneratedPlugin
}

module.exports = { createIntegration }
