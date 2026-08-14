'use strict'

const { storage } = require('../../../datadog-core')
const TracingPlugin = require('./tracing')

const legacyStorage = storage('legacy')

/**
 * @typedef {object} OrchestrionContext
 * @property {unknown[]} arguments
 * @property {unknown} [self]
 * @property {unknown} [result]
 * @property {unknown} [error]
 * @property {{ span?: import('../../../..').Span }} [currentStore]
 * @property {{ span?: import('../../../..').Span }} [parentStore]
 */

/**
 * @typedef {object} PipelineFrame
 * @property {OrchestrionContext} context
 * @property {Record<string, unknown>} data
 * @property {import('../../../..').Span | undefined} span
 * @property {Record<string, unknown>} config
 * @property {object} tracer
 * @property {TracingPlugin} plugin
 */

/**
 * @template T
 * @typedef {T | ((frame: PipelineFrame) => T)} Resolvable
 */

/**
 * @typedef {object} PipelineStage
 * @property {string} name
 * @property {(frame: PipelineFrame) => void} [start]
 * @property {(frame: PipelineFrame) => void} [complete]
 * @property {(frame: PipelineFrame) => void} [error]
 */

/**
 * @typedef {object} OrchestrionSpanDefinition
 * @property {Resolvable<string>} name
 * @property {Resolvable<string | {name: string, source?: string} | undefined>} [service]
 * @property {Resolvable<string | undefined>} [resource]
 * @property {Resolvable<string | undefined>} [type]
 * @property {Resolvable<string | undefined>} [kind]
 * @property {Resolvable<import('../../../..').Span | null | undefined>} [childOf]
 * @property {Record<string, Resolvable<string | number | boolean | undefined>>} [tags]
 * @property {Record<string, Resolvable<number | undefined>>} [metrics]
 * @property {Record<string, Resolvable<string | number | boolean | undefined>>} [resultTags]
 */

/**
 * @typedef {object} OrchestrionOperation
 * @property {{module: string, name: string}} target
 * @property {'sync' | 'async'} lifecycle
 * @property {{
 *   start?: Record<string, (context: OrchestrionContext, frame: PipelineFrame) => unknown>,
 *   complete?: Record<string, (context: OrchestrionContext, frame: PipelineFrame) => unknown>
 * }} [extract]
 * @property {(frame: PipelineFrame) => boolean} [when]
 * @property {'parent' | 'noop'} [skip]
 * @property {OrchestrionSpanDefinition} span
 * @property {PipelineStage[]} [stages]
 */

/**
 * @typedef {OrchestrionOperation & {stages: PipelineStage[]}} NormalizedOperation
 */

/**
 * @typedef {object} OrchestrionIntegration
 * @property {string} id
 * @property {(config: Record<string, unknown>) => Record<string, unknown>} [configure]
 * @property {OrchestrionOperation[]} operations
 */

/**
 * Read a property path without allocating intermediate arrays on each invocation.
 *
 * @param {unknown} value
 * @param {(string | number)[]} path
 * @returns {unknown}
 */
function readPath (value, path) {
  for (let i = 0; i < path.length; i++) {
    if (value === null || value === undefined) return
    value = Reflect.get(Object(value), path[i])
  }
  return value
}

/**
 * Select a value from an Orchestrion argument.
 *
 * @param {number} index
 * @param {...(string | number)} path
 * @returns {(context: OrchestrionContext) => unknown}
 */
function argument (index, ...path) {
  return context => readPath(context.arguments?.[index], path)
}

/**
 * Select a value from the instrumented receiver.
 *
 * @param {...(string | number)} path
 * @returns {(context: OrchestrionContext) => unknown}
 */
function self (...path) {
  return context => readPath(context.self, path)
}

/**
 * Select a value from the completed invocation result.
 *
 * @param {...(string | number)} path
 * @returns {(context: OrchestrionContext) => unknown}
 */
function result (...path) {
  return context => readPath(context.result, path)
}

/**
 * Select a previously extracted semantic field.
 *
 * @param {string} name
 * @returns {(frame: PipelineFrame) => unknown}
 */
function field (name) {
  return frame => frame.data[name]
}

/**
 * Create a semantic data record with an explicit boundary type.
 *
 * @returns {Record<string, unknown>}
 */
function createRecord () {
  return {}
}

/**
 * Resolve a literal or frame-dependent value.
 *
 * @template T
 * @param {Resolvable<T>} value
 * @param {PipelineFrame} frame
 * @returns {T}
 */
function resolveValue (value, frame) {
  return typeof value === 'function' ? Reflect.apply(value, undefined, [frame]) : value
}

/**
 * Determine whether a diagnostic-channel message has the Orchestrion envelope.
 *
 * @param {unknown} value
 * @returns {value is OrchestrionContext}
 */
function isOrchestrionContext (value) {
  return value !== null && typeof value === 'object' &&
    'arguments' in value && Array.isArray(value.arguments)
}

/**
 * Validate and narrow a diagnostic-channel message at the pipeline boundary.
 *
 * @param {unknown} value
 * @returns {OrchestrionContext}
 */
function requireContext (value) {
  if (isOrchestrionContext(value)) return value
  throw new TypeError('Orchestrion pipeline received an invalid context')
}

/**
 * Call the existing span helper with its supported context-object mode, which its legacy
 * boolean-only JSDoc does not express.
 *
 * @param {TracingPlugin} plugin
 * @param {string} name
 * @param {object} options
 * @param {OrchestrionContext} context
 * @returns {import('../../../..').Span}
 */
function startSpan (plugin, name, options, context) {
  return Reflect.apply(plugin.startSpan, plugin, [name, options, context])
}

/**
 * Create the normalized frame passed through every pipeline stage.
 *
 * @param {TracingPlugin} plugin
 * @param {OrchestrionContext} context
 * @param {Record<string, unknown>} data
 * @returns {PipelineFrame}
 */
function createFrame (plugin, context, data) {
  return {
    context,
    data,
    span: undefined,
    config: plugin.config,
    tracer: plugin.tracer,
    plugin,
  }
}

/**
 * Resolve a record while omitting undefined values.
 *
 * @param {Record<string, Resolvable<string | number | boolean | undefined>> | undefined} values
 * @param {PipelineFrame} frame
 * @returns {Record<string, unknown> | undefined}
 */
function resolveRecord (values, frame) {
  if (!values) return

  const resolved = createRecord()
  let hasValue = false
  for (const [name, value] of Object.entries(values)) {
    const result = resolveValue(value, frame)
    if (result !== undefined) {
      resolved[name] = result
      hasValue = true
    }
  }
  return hasValue ? resolved : undefined
}

/**
 * Extract semantic fields from the canonical Orchestrion context.
 *
 * @param {Record<string, (context: OrchestrionContext, frame: PipelineFrame) => unknown> | undefined} extractors
 * @param {OrchestrionContext} context
 * @param {PipelineFrame} frame
 * @returns {void}
 */
function extract (extractors, context, frame) {
  if (!extractors) return
  for (const [name, extractor] of Object.entries(extractors)) {
    frame.data[name] = extractor(context, frame)
  }
}

/**
 * Run a phase in declaration order for start and reverse order while unwinding.
 *
 * @param {PipelineStage[]} stages
 * @param {'start' | 'complete' | 'error'} phase
 * @param {PipelineFrame} frame
 * @returns {void}
 */
function runStages (stages, phase, frame) {
  if (phase === 'start') {
    for (let i = 0; i < stages.length; i++) {
      stages[i].start?.(frame)
    }
    return
  }

  for (let i = stages.length - 1; i >= 0; i--) {
    stages[i][phase]?.(frame)
  }
}

/**
 * Start one invocation pipeline and bind its span store.
 *
 * @param {TracingPlugin} plugin
 * @param {NormalizedOperation} operation
 * @param {OrchestrionContext} context
 * @param {WeakMap<object, PipelineFrame>} frames
 * @returns {object | undefined}
 */
function startOperation (plugin, operation, context, frames) {
  const data = createRecord()
  const frame = createFrame(plugin, context, data)
  extract(operation.extract?.start, context, frame)
  frames.set(context, frame)

  if (operation.when && !operation.when(frame)) {
    frames.delete(context)
    return operation.skip === 'noop' ? { noop: true } : legacyStorage.getStore()
  }

  const span = operation.span
  frame.span = startSpan(plugin, resolveValue(span.name, frame), {
    service: resolveValue(span.service, frame),
    resource: resolveValue(span.resource, frame),
    type: resolveValue(span.type, frame),
    kind: resolveValue(span.kind, frame),
    childOf: resolveValue(span.childOf, frame),
    meta: resolveRecord(span.tags, frame),
    metrics: resolveRecord(span.metrics, frame),
  }, context)

  return context.currentStore
}

/**
 * Run start stages after the tracing channel has installed the bound span store.
 *
 * @param {NormalizedOperation} operation
 * @param {OrchestrionContext} context
 * @param {WeakMap<object, PipelineFrame>} frames
 * @returns {void}
 */
function beginOperation (operation, context, frames) {
  const frame = frames.get(context)
  if (!frame?.span) return
  runStages(operation.stages, 'start', frame)
}

/**
 * Record an invocation error without completing the span early.
 *
 * @param {TracingPlugin} plugin
 * @param {NormalizedOperation} operation
 * @param {OrchestrionContext} context
 * @param {WeakMap<object, PipelineFrame>} frames
 * @returns {void}
 */
function errorOperation (plugin, operation, context, frames) {
  const frame = frames.get(context)
  if (!frame?.span) return

  plugin.addError(context.error, frame.span)
  runStages(operation.stages, 'error', frame)
}

/**
 * Finish one invocation after extracting outcome data and applying final tags.
 *
 * @param {NormalizedOperation} operation
 * @param {OrchestrionContext} context
 * @param {WeakMap<object, PipelineFrame>} frames
 * @returns {void}
 */
function completeOperation (operation, context, frames) {
  const frame = frames.get(context)
  if (!frame?.span) return

  try {
    extract(operation.extract?.complete, context, frame)
    const resultTags = resolveRecord(operation.span.resultTags, frame)
    if (resultTags) frame.span.addTags(resultTags)
    runStages(operation.stages, 'complete', frame)
  } finally {
    frames.delete(context)
    frame.span.finish()
  }
}

/**
 * Validate the declarative boundary once, before it reaches an application hot path.
 *
 * @param {OrchestrionIntegration} definition
 * @returns {void}
 */
function validateDefinition (definition) {
  if (!definition || typeof definition.id !== 'string' || definition.id.length === 0) {
    throw new TypeError('Orchestrion integration requires a non-empty id')
  }
  if (!Array.isArray(definition.operations) || definition.operations.length === 0) {
    throw new TypeError(`Orchestrion integration "${definition.id}" requires at least one operation`)
  }

  const targets = new Set()
  for (const operation of definition.operations) {
    const { target, lifecycle, span } = operation
    if (!target || typeof target.module !== 'string' || typeof target.name !== 'string') {
      throw new TypeError(`Orchestrion integration "${definition.id}" has an invalid target`)
    }
    if (lifecycle !== 'sync' && lifecycle !== 'async') {
      throw new TypeError(`Orchestrion operation "${target.name}" requires a sync or async lifecycle`)
    }
    if (!span || span.name === undefined) {
      throw new TypeError(`Orchestrion operation "${target.name}" requires a span name`)
    }

    const targetName = `${target.module}:${target.name}`
    if (targets.has(targetName)) {
      throw new TypeError(`Orchestrion integration "${definition.id}" repeats target "${targetName}"`)
    }
    targets.add(targetName)
  }
}

/**
 * Normalize optional operation fields once at plugin-definition time.
 *
 * @param {OrchestrionOperation[]} operations
 * @returns {NormalizedOperation[]}
 */
function normalizeOperations (operations) {
  return operations.map(operation => ({
    ...operation,
    stages: operation.stages || [],
  }))
}

/**
 * Compile a declarative Orchestrion integration into the existing plugin-manager contract.
 *
 * This is intentionally an internal PoC: integration authors describe operations, while the
 * generated class remains a compatibility adapter for the current PluginManager.
 *
 * @param {OrchestrionIntegration} definition
 * @returns {typeof TracingPlugin}
 */
function createOrchestrionPlugin (definition) {
  validateDefinition(definition)
  const operations = normalizeOperations(definition.operations)

  return class OrchestrionPipelinePlugin extends TracingPlugin {
    static id = definition.id
    static operation = definition.id

    /**
     * Subscribe every declared operation to its canonical Orchestrion lifecycle.
     *
     * @param {...unknown} args
     */
    constructor (...args) {
      super(...args)

      const frames = new WeakMap()
      for (const operation of operations) {
        const prefix = `tracing:orchestrion:${operation.target.module}:${operation.target.name}`
        this.addBind(`${prefix}:start`, message => startOperation(this, operation, requireContext(message), frames))
        this.addSub(`${prefix}:start`, message => beginOperation(operation, requireContext(message), frames))
        this.addSub(`${prefix}:error`, message => errorOperation(this, operation, requireContext(message), frames))

        if (operation.lifecycle === 'sync') {
          this.addSub(`${prefix}:end`, message => completeOperation(operation, requireContext(message), frames))
        } else {
          this.addSub(`${prefix}:end`, message => {
            const context = requireContext(message)
            if (context.error !== undefined) completeOperation(operation, context, frames)
          })
          this.addSub(`${prefix}:asyncEnd`, message => completeOperation(operation, requireContext(message), frames))
        }
      }
    }

    /**
     * Disable TracingPlugin's convention-based subscriptions; the definition owns routing.
     *
     * @returns {void}
     */
    addTraceSubs () {}

    /**
     * Normalize integration-specific configuration before enabling the generated plugin.
     *
     * @param {boolean | Record<string, unknown>} config
     * @returns {object}
     */
    configure (config) {
      if (typeof config !== 'boolean' && definition.configure) {
        config = definition.configure(config)
      }
      return super.configure(config)
    }
  }
}

module.exports = {
  argument,
  createOrchestrionPlugin,
  field,
  result,
  self,
}
