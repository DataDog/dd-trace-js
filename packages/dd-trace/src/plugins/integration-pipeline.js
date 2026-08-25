'use strict'

const { storage } = require('../../../datadog-core')
const log = require('../log')
const { addExitCodeOrigin } = require('./stages/code-origin')
const { addPeerService } = require('./stages/peer-service')
const TracingPlugin = require('./tracing')

const contextStorage = storage('context')
const spanStorage = storage('span')
const legacyStorage = storage('legacy')
const spanContextKey = Symbol('integration.pipeline.span_context')
// Scope-based diagnostic channels enter bound stores in registration order. Older run-based channels nest them in
// reverse order, so registration must preserve the same context -> legacy -> span nesting across both implementations.
const storeBindingsRunInRegistrationOrder = typeof contextStorage.withScope === 'function'
const definitionFields = new Set(['id', 'source', 'configure', 'operations'])
const extractorPhases = new Set(['start', 'complete'])
const spanFields = new Set(['enabled', 'name', 'service', 'resource', 'type', 'kind', 'tags', 'metrics', 'resultTags'])
const stageFields = new Set(['name', 'requires', 'start', 'complete', 'error'])

/**
 * @typedef {object} InvocationContext
 * @property {unknown[]} arguments
 * @property {unknown} [self]
 * @property {unknown} [result]
 * @property {unknown} [error]
 * @property {object} [currentStore]
 * @property {object} [parentStore]
 * @property {object} [currentContextStore]
 * @property {object} [parentContextStore]
 */

/**
 * Span-independent correlation information for an invocation.
 *
 * @typedef {object} CorrelationContext
 * @property {string} traceId
 * @property {string} traceId128
 * @property {string} spanId
 * @property {(format: string, carrier: object) => object | undefined} inject
 */

/**
 * A narrow tracing capability. It intentionally exposes tag assignment, not a span.
 *
 * @typedef {object} TraceCapability
 * @property {(name: string, value: unknown) => void} setTag
 */

/**
 * @typedef {object} PipelineFrame
 * @property {InvocationContext} invocation
 * @property {Record<string, unknown>} data
 * @property {CorrelationContext | undefined} correlation
 * @property {TraceCapability} trace
 * @property {Record<string, unknown>} config
 * @property {(options: object) => string | {name: string, source?: string}} serviceName
 * @property {{extract: (format: string, carrier: object) => object | null}} propagation
 * @property {{
 *   decode: (carrier: object | undefined) => object | undefined,
 *   setCheckpoint: (edgeTags: string[], payloadSize?: number) => object | undefined
 * }} dataStreams
 */

/**
 * @template T
 * @typedef {T | ((frame: PipelineFrame) => T)} Resolvable
 */

/**
 * Stages without the `tracing` requirement start before a span exists. Stages which require
 * tracing start after the independent span store has been bound. All terminal hooks unwind in
 * reverse start order.
 *
 * @typedef {object} PipelineStage
 * @property {string} name
 * @property {Array<'tracing'>} [requires]
 * @property {(frame: PipelineFrame) => void} [start]
 * @property {(frame: PipelineFrame) => void} [complete]
 * @property {(frame: PipelineFrame) => void} [error]
 */

/**
 * @typedef {object} IntegrationSpanDefinition
 * @property {Resolvable<boolean>} [enabled]
 * @property {Resolvable<string>} name
 * @property {Resolvable<string | {name: string, source?: string} | undefined>} [service]
 * @property {Resolvable<string | undefined>} [resource]
 * @property {Resolvable<string | undefined>} [type]
 * @property {Resolvable<string | undefined>} [kind]
 * @property {Record<string, Resolvable<string | number | boolean | undefined>> |
 *   ((frame: PipelineFrame) => Record<string, unknown> | undefined)} [tags]
 * @property {Record<string, Resolvable<number | undefined>> |
 *   ((frame: PipelineFrame) => Record<string, unknown> | undefined)} [metrics]
 * @property {Record<string, Resolvable<string | number | boolean | undefined>> |
 *   ((frame: PipelineFrame) => Record<string, unknown> | undefined)} [resultTags]
 */

/**
 * @typedef {object} IntegrationOperation
 * @property {{module: string, name: string}} target
 * @property {'sync' | 'async'} lifecycle
 * @property {{
 *   parent?: Resolvable<import('../opentracing/span') | import('../opentracing/span_context') | null>
 * }} [context]
 * @property {{
 *   start?: Record<string, (invocation: InvocationContext, frame: PipelineFrame) => unknown> |
 *     ((invocation: InvocationContext) => Record<string, unknown> | undefined),
 *   complete?: Record<string, (invocation: InvocationContext, frame: PipelineFrame) => unknown> |
 *     ((invocation: InvocationContext, frame: PipelineFrame) => Record<string, unknown> | undefined)
 * }} [extract]
 * @property {(frame: PipelineFrame) => boolean} [when]
 * @property {Resolvable<'parent' | 'noop'>} [skip]
 * @property {IntegrationSpanDefinition} [span]
 * @property {PipelineStage[]} [stages]
 */

/**
 * @typedef {Array<[string, (invocation: InvocationContext, frame: PipelineFrame) => unknown]> |
 *   ((invocation: InvocationContext, frame?: PipelineFrame) => Record<string, unknown> | undefined)} CompiledExtractor
 */

/**
 * @typedef {Array<[string, unknown]> |
 *   ((frame: PipelineFrame) => Record<string, unknown> | undefined)} CompiledRecord
 */

/**
 * @typedef {IntegrationOperation & {
 *   stages: PipelineStage[],
 *   contextStages: PipelineStage[],
 *   tracingStages: PipelineStage[],
 *   sharesStartState: boolean,
 *   startExtractors?: CompiledExtractor,
 *   completeExtractors?: CompiledExtractor,
 *   tagResolvers?: CompiledRecord,
 *   metricResolvers?: CompiledRecord,
 *   resultTagResolvers?: CompiledRecord
 * }} NormalizedOperation
 */

/**
 * @typedef {object} IntegrationSource
 * @property {(target: {module: string, name: string}) => {
 *   start: string, end: string, asyncEnd: string, error: string
 * }} channels
 * @property {(value: unknown) => InvocationContext} invocation
 */

/**
 * @typedef {object} IntegrationDefinition
 * @property {string} id
 * @property {IntegrationSource} [source]
 * @property {(config: Record<string, unknown>) => Record<string, unknown>} [configure]
 * @property {IntegrationOperation[]} operations
 */

/**
 * @typedef {object} InvocationState
 * @property {PipelineFrame} frame
 * @property {import('../opentracing/span_context') | undefined} spanContext
 * @property {CorrelationContext} [correlation]
 * @property {import('../opentracing/span') | import('../opentracing/span_context') | null | undefined} parent
 * @property {import('../../../..').Span | undefined} span
 * @property {PipelineStage[] | undefined} startedStages
 * @property {Record<string, unknown>} [pendingTags]
 * @property {boolean} skipped
 * @property {boolean} failed
 */

const orchestrionSource = {
  channels (target) {
    const prefix = `tracing:orchestrion:${target.module}:${target.name}`
    return {
      start: `${prefix}:start`,
      end: `${prefix}:end`,
      asyncEnd: `${prefix}:asyncEnd`,
      error: `${prefix}:error`,
    }
  },
  invocation: requireInvocation,
}

function readPath (value, path) {
  for (let i = 0; i < path.length; i++) {
    if (value === null || value === undefined) return
    value = value[path[i]]
  }
  return value
}

function argument (index, ...path) {
  return invocation => readPath(invocation.arguments?.[index], path)
}

function self (...path) {
  return invocation => readPath(invocation.self, path)
}

function result (...path) {
  return invocation => readPath(invocation.result, path)
}

function field (name) {
  return frame => frame.data[name]
}

function createRecord () {
  return {}
}

function resolveValue (value, frame) {
  return typeof value === 'function' ? value(frame) : value
}

function requireInvocation (value) {
  if (value !== null && typeof value === 'object' && Array.isArray(value.arguments)) return value
  throw new TypeError('Integration pipeline received an invalid invocation')
}

class TraceCapability {
  #state

  /**
   * Create a trace annotation block for one invocation.
   *
   * @param {InvocationState} state
   */
  constructor (state) {
    this.#state = state
  }

  /**
   * Add a tag immediately or buffer it until the span is materialized.
   *
   * @param {string} name
   * @param {unknown} value
   * @returns {void}
   */
  setTag (name, value) {
    const state = this.#state
    if (state.span) {
      state.span.setTag(name, value)
    } else {
      state.pendingTags ||= createRecord()
      state.pendingTags[name] = value
    }
  }
}

class PropagationCapability {
  #tracer

  /**
   * Create a propagation block backed by the configured tracer.
   *
   * @param {object} tracer
   */
  constructor (tracer) {
    this.#tracer = tracer
  }

  /**
   * Extract distributed context from a carrier.
   *
   * @param {string} format
   * @param {object} carrier
   * @returns {object | null | undefined}
   */
  extract (format, carrier) {
    return this.#tracer.extract(format, carrier)
  }
}

class DataStreamsCapability {
  #frame
  #tracer

  /**
   * Create a data-streams block for one invocation.
   *
   * @param {object} tracer
   * @param {IntegrationFrame} frame
   */
  constructor (tracer, frame) {
    this.#tracer = tracer
    this.#frame = frame
  }

  /**
   * Decode an incoming data-streams carrier.
   *
   * @param {object} carrier
   * @returns {object | undefined}
   */
  decode (carrier) {
    return this.#tracer.decodeDataStreamsContext(carrier)
  }

  /**
   * Create a data-streams checkpoint associated with this invocation.
   *
   * @param {string[]} edgeTags
   * @param {number} [payloadSize]
   * @returns {object | undefined}
   */
  setCheckpoint (edgeTags, payloadSize) {
    return this.#tracer.setCheckpoint(edgeTags, this.#frame.trace, payloadSize)
  }
}

class IntegrationFrame {
  #dataStreams
  #plugin
  #propagation
  #state
  #trace

  /**
   * Create the semantic workspace for one integration invocation.
   *
   * @param {TracingPlugin} plugin
   * @param {InvocationContext} invocation
   * @param {InvocationState} state
   */
  constructor (plugin, invocation, state) {
    this.#plugin = plugin
    this.#state = state
    this.invocation = invocation
    this.config = plugin.config
  }

  /**
   * Materialize correlation identifiers only when an integration block reads them.
   *
   * @returns {CorrelationContext | undefined}
   */
  get correlation () {
    const state = this.#state
    if (state.spanContext && !state.correlation) {
      state.correlation = createCorrelation(this.#plugin.tracer, state.spanContext)
    }
    return state.correlation
  }

  /**
   * Get the trace annotation block, allocating it on first use.
   *
   * @returns {TraceCapability}
   */
  get trace () {
    this.#trace ||= new TraceCapability(this.#state)
    return this.#trace
  }

  /**
   * Get the propagation block, allocating it on first use.
   *
   * @returns {PropagationCapability}
   */
  get propagation () {
    this.#propagation ||= new PropagationCapability(this.#plugin.tracer)
    return this.#propagation
  }

  /**
   * Get the data-streams block, allocating it on first use.
   *
   * @returns {DataStreamsCapability}
   */
  get dataStreams () {
    this.#dataStreams ||= new DataStreamsCapability(this.#plugin.tracer, this)
    return this.#dataStreams
  }

  /**
   * Resolve an integration service name through the existing schema.
   *
   * @param {object} options
   * @returns {string | {name: string, source?: string}}
   */
  serviceName (options) {
    return this.#plugin.serviceName({ ...options, pluginConfig: this.config })
  }

  /**
   * Add exit code-origin tags when the tracer feature is enabled.
   *
   * @param {(topOfStackFunc: Function) => Record<string, unknown>} createTags
   * @param {Function} topOfStackFunc
   * @returns {void}
   */
  [addExitCodeOrigin] (createTags, topOfStackFunc) {
    const config = this.#plugin._tracerConfig.codeOriginForSpans
    if (!config?.enabled || !config.experimental?.exit_spans?.enabled) return

    this.#state.span.addTags(createTags(topOfStackFunc))
  }

  /**
   * Apply a built-in peer-service stage without exposing the span or tracer configuration.
   *
   * @param {(span: import('../opentracing/span'), tracerConfig: import('../config/config-base'),
   *   precursors: string[]) => void} tagPeerService
   * @param {string[]} precursors
   * @returns {void}
   */
  [addPeerService] (tagPeerService, precursors) {
    tagPeerService(this.#state.span, this.#plugin._tracerConfig, precursors)
  }
}

function compileRecord (record) {
  return typeof record === 'function' ? record : record ? Object.entries(record) : undefined
}

function compileExtractor (extractor) {
  return typeof extractor === 'function' ? extractor : extractor ? Object.entries(extractor) : undefined
}

function resolveRecord (resolver, frame) {
  if (!resolver) return
  if (typeof resolver === 'function') return resolver(frame)

  const resolved = createRecord()
  let hasValue = false
  for (const [name, value] of resolver) {
    const result = resolveValue(value, frame)
    if (result !== undefined) {
      resolved[name] = result
      hasValue = true
    }
  }
  return hasValue ? resolved : undefined
}

function extractStart (extractor, invocation, frame) {
  if (typeof extractor === 'function') {
    frame.data = extractor(invocation) || createRecord()
    return
  }

  frame.data = createRecord()
  if (!extractor) return
  for (const [name, extractField] of extractor) {
    frame.data[name] = extractField(invocation, frame)
  }
}

function extractComplete (extractor, invocation, frame) {
  if (!extractor) return
  if (typeof extractor === 'function') {
    const data = extractor(invocation, frame)
    if (data) Object.assign(frame.data, data)
    return
  }

  for (const [name, extractField] of extractor) {
    frame.data[name] = extractField(invocation, frame)
  }
}

function requiresTracing (stage) {
  return stage.requires?.includes('tracing') === true
}

function runStageHook (stage, phase, frame) {
  try {
    stage[phase]?.(frame)
  } catch (error) {
    log.error('Integration pipeline stage "%s" failed during %s: %s', stage.name, phase, error.message)
  }
}

function startStages (state, stages) {
  const { frame } = state
  for (const stage of stages) {
    state.startedStages.push(stage)
    runStageHook(stage, 'start', frame)
  }
}

function unwindStages (state, phase) {
  if (!state.startedStages) return
  for (let i = state.startedStages.length - 1; i >= 0; i--) {
    runStageHook(state.startedStages[i], phase, state.frame)
  }
}

function getParentContext (operation, frame) {
  if (operation.context && Object.hasOwn(operation.context, 'parent')) {
    const parent = resolveValue(operation.context.parent, frame)
    if (parent !== undefined) return parent
  }

  const activeCorrelation = contextStorage.getStore()?.correlation
  if (activeCorrelation?.[spanContextKey]) return activeCorrelation[spanContextKey]
  return legacyStorage.getStore()?.span
}

function createCorrelation (tracer, spanContext) {
  const correlation = {
    traceId: spanContext.toTraceId(),
    traceId128: spanContext.toTraceId(true),
    spanId: spanContext.toSpanId(),
    inject: (format, carrier) => tracer.inject(spanContext, format, carrier),
  }
  Object.defineProperty(correlation, spanContextKey, { value: spanContext })
  return Object.freeze(correlation)
}

function prepareOperation (plugin, operation, invocation, states) {
  let state = states.get(invocation)
  if (state) return state

  state = {
    frame: undefined,
    spanContext: undefined,
    parent: undefined,
    span: undefined,
    startedStages: operation.stages.length > 0 ? [] : undefined,
    skipped: false,
    failed: false,
  }
  const frame = new IntegrationFrame(plugin, invocation, state)
  state.frame = frame
  if (operation.sharesStartState) states.set(invocation, state)

  extractStart(operation.startExtractors, invocation, frame)
  if (operation.when && !operation.when(frame)) {
    state.skipped = true
    return state
  }

  if (!operation.sharesStartState) states.set(invocation, state)
  state.parent = getParentContext(operation, frame)
  state.spanContext = plugin.tracer.createSpanContext(state.parent)
  return state
}

function bindContext (plugin, operation, invocation, states) {
  const state = prepareOperation(plugin, operation, invocation, states)
  const parentStore = contextStorage.getStore()
  invocation.parentContextStore = parentStore
  if (state.skipped || state.failed) return parentStore

  invocation.currentContextStore = { ...parentStore, correlation: state.frame.correlation }
  return invocation.currentContextStore
}

function bindLegacySpan (plugin, operation, invocation, states) {
  const state = prepareOperation(plugin, operation, invocation, states)
  const parentStore = legacyStorage.getStore()
  if (state.failed) return parentStore
  if (state.skipped) {
    return resolveValue(operation.skip, state.frame) === 'noop' ? { noop: true } : parentStore
  }

  startStages(state, operation.contextStages)
  if (parentStore?.noop && !Object.hasOwn(invocation, 'currentStore')) return parentStore
  if (!operation.span || (operation.span.enabled !== undefined && !resolveValue(operation.span.enabled, state.frame))) {
    return parentStore
  }

  const span = operation.span
  state.span = plugin.startSpan(resolveValue(span.name, state.frame), {
    context: state.spanContext,
    childOf: state.parent,
    service: resolveValue(span.service, state.frame),
    resource: resolveValue(span.resource, state.frame),
    type: resolveValue(span.type, state.frame),
    kind: resolveValue(span.kind, state.frame),
    meta: resolveRecord(operation.tagResolvers, state.frame),
    metrics: resolveRecord(operation.metricResolvers, state.frame),
  }, invocation)
  if (state.pendingTags) state.span.addTags(state.pendingTags)
  return invocation.currentStore
}

function bindSpan (plugin, operation, invocation, states) {
  if (operation.contextStages.length === 0 && legacyStorage.getStore()?.noop) return spanStorage.getStore()
  const state = prepareOperation(plugin, operation, invocation, states)
  if (state.skipped || state.failed || !state.span) return spanStorage.getStore()
  return { ...spanStorage.getStore(), span: state.span }
}

function beginOperation (operation, invocation, states) {
  const state = states.get(invocation)
  if (!state || state.skipped || state.failed || !state.span) return
  startStages(state, operation.tracingStages)
}

function errorOperation (plugin, operation, invocation, states) {
  const state = states.get(invocation)
  if (!state || state.skipped) return
  if (state.span) plugin.addError(invocation.error, state.span)
  unwindStages(state, 'error')
}

function completeOperation (plugin, operation, invocation, states) {
  const state = states.get(invocation)
  if (!state) return

  try {
    if (state.skipped) return
    if (!state.failed) {
      try {
        extractComplete(operation.completeExtractors, invocation, state.frame)
        if (state.span) {
          const resultTags = resolveRecord(operation.resultTagResolvers, state.frame)
          if (resultTags) state.span.addTags(resultTags)
        }
      } catch (error) {
        logOperationFailure(plugin, operation, 'complete', error)
      }
    }
    unwindStages(state, 'complete')
  } finally {
    states.delete(invocation)
    if (state.span) plugin.finish(invocation)
  }
}

/**
 * Report an integration-authored lifecycle failure without throwing into the instrumented application.
 *
 * @param {TracingPlugin} plugin
 * @param {NormalizedOperation} operation
 * @param {'start' | 'complete'} phase
 * @param {unknown} error
 * @returns {void}
 */
function logOperationFailure (plugin, operation, phase, error) {
  log.error(
    'Integration pipeline "%s" operation "%s" failed during %s: %s',
    plugin.constructor.id,
    operation.target.name,
    phase,
    error?.message || error
  )
}

function bindSafely (plugin, operation, message, source, states, store, bind) {
  let invocation
  try {
    invocation = source.invocation(message)
    return bind(plugin, operation, invocation, states)
  } catch (error) {
    const state = invocation && states.get(invocation)
    if (state) state.failed = true
    logOperationFailure(plugin, operation, 'start', error)
    return store.getStore()
  }
}

function isRecord (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateFields (value, fields, description) {
  for (const name of Object.keys(value)) {
    if (!fields.has(name)) throw new TypeError(`${description} has an unknown "${name}" field`)
  }
}

function validateExtractor (extractor, description) {
  if (extractor === undefined || typeof extractor === 'function') return
  if (!isRecord(extractor)) throw new TypeError(`${description} must be a function or field record`)

  for (const [name, resolver] of Object.entries(extractor)) {
    if (typeof resolver !== 'function') {
      throw new TypeError(`${description} field "${name}" requires an extractor function`)
    }
  }
}

function validateSpan (span, operationName) {
  if (!isRecord(span)) throw new TypeError(`Integration operation "${operationName}" has an invalid span definition`)
  validateFields(span, spanFields, `Integration operation "${operationName}" span definition`)

  if ((typeof span.name !== 'string' || span.name.length === 0) && typeof span.name !== 'function') {
    throw new TypeError(`Integration operation "${operationName}" requires a span name or resolver`)
  }
  for (const fieldName of ['tags', 'metrics', 'resultTags']) {
    const value = span[fieldName]
    if (value !== undefined && typeof value !== 'function' && !isRecord(value)) {
      throw new TypeError(
        `Integration operation "${operationName}" span ${fieldName} must be a function or field record`
      )
    }
  }
}

function validateStage (stage, operationName) {
  if (!isRecord(stage)) throw new TypeError(`Integration operation "${operationName}" has an invalid stage`)
  validateFields(stage, stageFields, `Integration operation "${operationName}" stage`)

  if (typeof stage.name !== 'string' || stage.name.length === 0) {
    throw new TypeError(`Integration operation "${operationName}" has a stage without a non-empty name`)
  }
  if (stage.requires !== undefined && !Array.isArray(stage.requires)) {
    throw new TypeError(`Integration stage "${stage.name}" requires a capability list`)
  }
  for (const hook of ['start', 'complete', 'error']) {
    if (stage[hook] !== undefined && typeof stage[hook] !== 'function') {
      throw new TypeError(`Integration stage "${stage.name}" has an invalid ${hook} hook`)
    }
  }
}

function validateDefinition (definition) {
  if (!definition || typeof definition.id !== 'string' || definition.id.length === 0) {
    throw new TypeError('Integration pipeline requires a non-empty id')
  }

  if (!Array.isArray(definition.operations) || definition.operations.length === 0) {
    throw new TypeError(`Integration pipeline "${definition.id}" requires at least one operation`)
  }
  validateFields(definition, definitionFields, `Integration pipeline "${definition.id}" definition`)

  const targets = new Set()
  for (const operation of definition.operations) {
    if (!isRecord(operation)) {
      throw new TypeError(`Integration pipeline "${definition.id}" has an invalid operation`)
    }
    const { target, lifecycle, span, stages = [] } = operation
    if (!target || typeof target.module !== 'string' || target.module.length === 0 ||
      typeof target.name !== 'string' || target.name.length === 0) {
      throw new TypeError(`Integration pipeline "${definition.id}" has an invalid target`)
    }
    if (lifecycle !== 'sync' && lifecycle !== 'async') {
      throw new TypeError(`Integration operation "${target.name}" requires a sync or async lifecycle`)
    }
    if (operation.skip !== undefined && typeof operation.skip !== 'function' &&
      operation.skip !== 'parent' && operation.skip !== 'noop') {
      throw new TypeError(`Integration operation "${target.name}" has an invalid skip mode`)
    }
    if (operation.when !== undefined && typeof operation.when !== 'function') {
      throw new TypeError(`Integration operation "${target.name}" requires a when function`)
    }
    if (operation.extract !== undefined) {
      if (!isRecord(operation.extract)) {
        throw new TypeError(`Integration operation "${target.name}" has an invalid extract definition`)
      }
      validateFields(operation.extract, extractorPhases, `Integration operation "${target.name}" extract definition`)
      validateExtractor(operation.extract.start, `Integration operation "${target.name}" extract.start`)
      validateExtractor(operation.extract.complete, `Integration operation "${target.name}" extract.complete`)
    }
    if (span !== undefined) validateSpan(span, target.name)
    if (!Array.isArray(stages)) {
      throw new TypeError(`Integration operation "${target.name}" requires a stage list`)
    }
    for (const stage of stages) {
      validateStage(stage, target.name)
      if (stage.requires?.some(capability => capability !== 'tracing')) {
        throw new TypeError(`Integration stage "${stage.name}" requires an unknown capability`)
      }
      if (!span && requiresTracing(stage)) {
        throw new TypeError(`Integration stage "${stage.name}" requires tracing but the operation does not trace`)
      }
    }

    const targetName = `${target.module}:${target.name}`
    if (targets.has(targetName)) {
      throw new TypeError(`Integration pipeline "${definition.id}" repeats target "${targetName}"`)
    }
    targets.add(targetName)
  }
}

function normalizeOperations (operations) {
  return operations.map(operation => {
    const stages = operation.stages || []
    const contextStages = []
    const tracingStages = []
    for (const stage of stages) {
      if (requiresTracing(stage)) {
        tracingStages.push(stage)
      } else {
        contextStages.push(stage)
      }
    }
    return {
      ...operation,
      stages,
      contextStages,
      tracingStages,
      sharesStartState: contextStages.length > 0 || tracingStages.length > 0,
      startExtractors: compileExtractor(operation.extract?.start),
      completeExtractors: compileExtractor(operation.extract?.complete),
      tagResolvers: compileRecord(operation.span?.tags),
      metricResolvers: compileRecord(operation.span?.metrics),
      resultTagResolvers: compileRecord(operation.span?.resultTags),
    }
  })
}

/**
 * Compile a declarative integration into the current plugin-manager contract.
 * Orchestrion is the default event source today, but routing is kept behind a source adapter.
 *
 * @param {IntegrationDefinition} definition
 * @returns {typeof TracingPlugin}
 */
function createIntegrationPlugin (definition) {
  validateDefinition(definition)
  const operations = normalizeOperations(definition.operations)
  const source = definition.source || orchestrionSource

  return class IntegrationPipeline extends TracingPlugin {
    static id = definition.id
    static operation = definition.id

    constructor (...args) {
      super(...args)

      const states = new WeakMap()
      for (const operation of operations) {
        const channels = source.channels(operation.target)
        const invocation = message => source.invocation(message)

        const contextSubscriptionOptions = operation.contextStages.length > 0 ? { allowNoop: true } : undefined
        const bindContextStore = message =>
          bindSafely(this, operation, message, source, states, contextStorage, bindContext)
        const bindTracingStore = message =>
          bindSafely(this, operation, message, source, states, spanStorage, bindSpan)

        // Register only the capability stores used by stages. Legacy storage remains the common span lifecycle block
        // and sits between context and tracing regardless of the diagnostic-channel store implementation.
        if (storeBindingsRunInRegistrationOrder && operation.contextStages.length > 0) {
          this.addStoreBind(channels.start, contextStorage, bindContextStore)
        }
        if (!storeBindingsRunInRegistrationOrder && operation.tracingStages.length > 0) {
          this.addStoreBind(channels.start, spanStorage, bindTracingStore)
        }
        this.addBind(channels.start,
          message => bindSafely(this, operation, message, source, states, legacyStorage, bindLegacySpan),
          contextSubscriptionOptions)
        if (storeBindingsRunInRegistrationOrder && operation.tracingStages.length > 0) {
          this.addStoreBind(channels.start, spanStorage, bindTracingStore)
        }
        if (!storeBindingsRunInRegistrationOrder && operation.contextStages.length > 0) {
          this.addStoreBind(channels.start, contextStorage, bindContextStore)
        }
        if (operation.tracingStages.length > 0) {
          this.addSub(channels.start, message => beginOperation(operation, invocation(message), states))
        }
        this.addSub(channels.error,
          message => errorOperation(this, operation, invocation(message), states), contextSubscriptionOptions)

        // A rejected operation may bind a no-op legacy scope. Completion must still delete its WeakMap state.
        const completionOptions = { allowNoop: true }

        if (operation.lifecycle === 'sync') {
          this.addSub(channels.end,
            message => completeOperation(this, operation, invocation(message), states), completionOptions)
        } else {
          this.addSub(channels.end, message => {
            const current = invocation(message)
            if (current.error !== undefined) completeOperation(this, operation, current, states)
          }, completionOptions)
          this.addSub(channels.asyncEnd,
            message => completeOperation(this, operation, invocation(message), states), completionOptions)
        }
      }
    }

    addTraceSubs () {}

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
  createIntegrationPlugin,
  field,
  result,
  self,
}
