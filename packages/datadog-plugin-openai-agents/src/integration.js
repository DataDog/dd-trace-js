'use strict'

const { storage } = require('../../datadog-core')
const { storage: llmobsStorage } = require('../../dd-trace/src/llmobs/storage')
const LLMObsTagger = require('../../dd-trace/src/llmobs/tagger')
const { PARENT_ID_KEY } = require('../../dd-trace/src/llmobs/constants/tags')
const log = require('../../dd-trace/src/log')
const { getOpenAIModelProvider } = require('../../dd-trace/src/llmobs/plugins/openai/utils')
const {
  extractInputMessages,
  extractOutputMessages,
  extractGenerationOutputMessages,
  extractMetrics,
  extractMetadata,
} = require('../../dd-trace/src/llmobs/plugins/openai-agents/utils')
const { AGENTS_ERROR_TYPE, applyError, deriveSpanName } = require('./util')

const COMPONENT = 'openai-agents'
const DEFAULT_MODEL_PROVIDER = 'openai'
// Bounds the agents-core parent-chain walk so a cyclic chain from a future
// agents-core version can't spin on the span-start hot path.
const MAX_ANCESTOR_WALK = 32
const MAX_MANIFEST_DEPTH = 20
const MAX_MANIFEST_NODES = 10_000
const MODEL_BASE_URL_STORE_KEY = Symbol('openai-agents.model-base-url')
const MODEL_CALL_STORE_KEY = Symbol('openai-agents.model-call')
const legacyStorage = storage('legacy')

const KIND_TO_SPAN_KIND = {
  agent: 'internal',
  tool: 'internal',
  task: 'internal',
  llm: 'client',
}

/**
 * @typedef {{
 *   spanId: string,
 *   traceId: string,
 *   currentTopLevelAgentSpanId?: string,
 *   currentTopLevelAgentName?: string,
 *   inputOaiSpan?: object,
 *   inputMessages?: Array<{ role: string, content: string }>,
 *   outputOaiSpan?: object,
 *   metadata?: Record<string, unknown>,
 *   groupId?: string,
 *   llmobsParentStore?: object,
 *   activeSpanCount: number,
 *   completionRequested: boolean,
 * }} LLMObsTraceInfo
 */

/**
 * @typedef {{
 *   parentId: string | null,
 *   traceId?: string,
 *   activeChildCount: number,
 *   ended: boolean,
 * }} UntracedSpanInfo
 */

/**
 * Owns tracer/tagger refs, maps agents-core span ids → dd-trace spans, and
 * reconstructs workflow-level input/output from the first and last response
 * spans of the top-level agent.
 */
class OpenAIAgentsIntegration {
  #tracer
  #config
  #enabled = false
  #llmobsEnabled = true
  #service
  /**
   * LLMObs is gated independently of APM tracing: when DD_LLMOBS_ENABLED is
   * false we keep emitting APM spans for the agent workflow but skip all
   * LLMObs tagging and the work that feeds it.
   * @type {LLMObsTagger}
   */
  #tagger
  /** @type {Map<string, import('../../dd-trace/src/opentracing/span')>} */
  #oaiToDdSpan = new Map()
  /**
   * @type {Map<string, {
   *   agentsCoreSpanId: string,
   *   agentDdSpan: object,
   *   providerSpans: object[],
   *   responseDdSpan?: object
  * }>}
  */
  #modelCallHolders = new Map()
  /**
   * agents-core spans we deliberately don't trace (`task` / `turn`). Ended
   * nodes stay walkable only while an observed child callback is still active.
   * @type {Map<string, UntracedSpanInfo>}
   */
  #untracedSpans = new Map()
  /** @type {Map<string, LLMObsTraceInfo>} */
  #traceInfo = new Map()
  #manifestTagged = new WeakSet()

  constructor ({ tracer, config } = {}) {
    this.#tracer = tracer
    this.#config = config ?? { llmobs: {} }
    this.#tagger = new LLMObsTagger(this.#config, true)
  }

  get enabled () {
    return this.#enabled
  }

  /**
   * Apply plugin lifecycle configuration.
   *
   * @param {{ enabled?: boolean, llmobs?: boolean, service?: string }} [config]
   */
  configure (config) {
    this.#enabled = !!config?.enabled
    this.#llmobsEnabled = config?.llmobs !== false
    this.#service = config?.service
  }

  /**
   * Resolve the dd-trace span for an agents-core spanId. When the id belongs to
   * a span type we don't trace — agents-core >=0.14 runs model calls inside a
   * `turn` span — the nearest traced ancestor's span is returned so callers
   * still activate the enclosing agent span.
   *
   * @param {string | undefined | null} spanId agents-core spanId
   * @returns {import('../../dd-trace/src/opentracing/span') | undefined}
   */
  getDDSpan (spanId) {
    return this.#oaiToDdSpan.get(this.#nearestTracedAncestorId(spanId))
  }

  getOrCreateModelCallHolder (agentsCoreSpanId, agentDdSpan) {
    let holder = this.#modelCallHolders.get(agentsCoreSpanId)
    if (!holder) {
      holder = { agentsCoreSpanId, agentDdSpan, providerSpans: [] }
      this.#modelCallHolders.set(agentsCoreSpanId, holder)
    }
    return holder
  }

  getModelCallHolderForProviderSpan (span) {
    const parentId = span?.context()._parentId?.toString(10)
    if (!parentId) return

    for (const holder of this.#modelCallHolders.values()) {
      if (holder.agentDdSpan.context().toSpanId().toString() === parentId) return holder
    }
  }

  trackProviderSpan (holder, span) {
    if (!span) return
    for (const ownedSpan of this.#oaiToDdSpan.values()) {
      if (ownedSpan === span) return
    }
    if (span.context()._parentId?.toString(10) !== holder.agentDdSpan.context().toSpanId().toString()) return
    holder.providerSpans.push(span)
    this.reparentProviderSpans(holder)
  }

  reparentProviderSpans (holder) {
    const responseSpan = holder.responseDdSpan
    if (!responseSpan || !this.#isLLMObsEnabled()) return
    const parentId = responseSpan.context().toSpanId()
    for (const providerSpan of holder.providerSpans) {
      if (providerSpan === responseSpan || !LLMObsTagger.tagMap.has(providerSpan)) continue
      this.#tagger._setTag(providerSpan, PARENT_ID_KEY, parentId)
    }
  }

  /**
   * Remember an untraced agents-core span's parent so the chain stays walkable.
   *
   * @param {object} oaiSpan
   */
  recordUntracedSpan (oaiSpan) {
    const { spanId } = oaiSpan
    if (!spanId || this.#untracedSpans.has(spanId)) return

    const parentId = oaiSpan.parentId ?? null
    this.#untracedSpans.set(spanId, {
      parentId,
      traceId: oaiSpan.traceId,
      activeChildCount: 0,
      ended: false,
    })
    this.#retainUntracedParent(parentId)
    this.#spanStarted(oaiSpan.traceId)
  }

  /**
   * Mark an untraced span callback complete. Its ancestry remains available
   * until every observed child callback has completed.
   *
   * @param {object} oaiSpan
   */
  endUntracedSpan (oaiSpan) {
    const info = this.#untracedSpans.get(oaiSpan.spanId)
    if (!info || info.ended) return

    // agents-core does not end its trace when the run throws. In 0.14 the
    // failure can live on the root task before any agent span exists, making
    // this structural callback the only opportunity to finish the workflow.
    if (oaiSpan.error && this.#isTopLevelSpan(oaiSpan)) {
      this.#requestWorkflowCompletion(oaiSpan.traceId, oaiSpan)
    }

    info.ended = true
    this.#pruneUntracedSpan(oaiSpan.spanId, info)
    this.#spanEnded(info.traceId)
  }

  /**
   * Ensure a function span is available synchronously at Tool.invoke. Newer
   * agents-core versions dispatch processor callbacks after an async exporter
   * callback, which can otherwise happen after user tool code has started.
   *
   * @param {object} oaiSpan
   * @returns {import('../../dd-trace/src/opentracing/span') | undefined}
   */
  getOrStartToolSpan (oaiSpan) {
    if (!oaiSpan?.spanId) return
    const existingSpan = this.#oaiToDdSpan.get(oaiSpan.spanId)
    if (existingSpan) return existingSpan
    this.startSpan(oaiSpan, 'tool')
    return this.#oaiToDdSpan.get(oaiSpan.spanId)
  }

  /**
   * Attach the declared agent configuration to the corresponding LLMObs span.
   *
   * @param {object | undefined} agentsCoreSpan
   * @param {object | undefined} agent
   */
  tagAgentManifest (agentsCoreSpan, agent) {
    if (!this.#isLLMObsEnabled() || !agentsCoreSpan || !agent) return
    const ddSpan = this.getDDSpan(agentsCoreSpan.spanId)
    if (!ddSpan || this.#manifestTagged.has(ddSpan)) return

    try {
      const manifest = buildAgentManifest(agent)
      this.#tagger.tagMetadata(ddSpan, { _dd: { agent_manifest: manifest } })
      this.#manifestTagged.add(ddSpan)
    } catch (error) {
      log.debug('[openai-agents] agent manifest tagging failed: %s', error)
    }
  }

  clearState () {
    // Finish any dd-trace spans still in-flight so we don't leak open traces
    // when agents-core's TracingProcessor.shutdown() runs (e.g., process
    // exiting mid-run).
    for (const ddSpan of this.#oaiToDdSpan.values()) {
      ddSpan.finish()
    }
    this.#oaiToDdSpan.clear()
    this.#modelCallHolders.clear()
    this.#untracedSpans.clear()
    this.#traceInfo.clear()
  }

  // ── Trace lifecycle ─────────────────────────────────────────────────────────

  startTrace (oaiTrace) {
    const traceId = oaiTrace.traceId
    if (!traceId) return

    const name = oaiTrace.name || 'Agent workflow'
    const parentSpan = legacyStorage.getStore()?.span
    const ddSpan = this.#tracer.startSpan(name, {
      childOf: parentSpan,
      tags: this.#getSpanTags('internal'),
    })
    const llmobsParentStore = this.#isLLMObsEnabled() ? llmobsStorage.getStore() : undefined
    this.#oaiToDdSpan.set(traceId, ddSpan)
    this.#traceInfo.set(traceId, {
      spanId: ddSpan.context().toSpanId(),
      traceId,
      groupId: oaiTrace.groupId || undefined,
      metadata: oaiTrace.metadata,
      llmobsParentStore,
      activeSpanCount: 0,
      completionRequested: false,
    })

    if (this.#isLLMObsEnabled()) {
      this.#tagger.registerLLMObsSpan(ddSpan, {
        kind: 'workflow',
        name,
        integration: COMPONENT,
        parent: llmobsParentStore?.span,
        sessionId: oaiTrace.groupId || undefined,
      })
      if (LLMObsTagger.tagMap.has(ddSpan)) {
        llmobsStorage.enterWith({ ...llmobsParentStore, span: ddSpan })
      }
    }
  }

  endTrace (oaiTrace) {
    this.#requestWorkflowCompletion(oaiTrace.traceId)
  }

  /**
   * Request workflow completion after all observed span callbacks finish.
   * Error tags are applied immediately so the agents-core span does not need
   * to be retained while completion is pending.
   *
   * @param {string | undefined} traceId
   * @param {object} [rootSpan] - top-level oai-span that ended in error.
   */
  #requestWorkflowCompletion (traceId, rootSpan) {
    if (!traceId) return
    const ddSpan = this.#oaiToDdSpan.get(traceId)
    if (!ddSpan) return
    const info = this.#traceInfo.get(traceId)

    if (rootSpan?.error) {
      ddSpan.setTag('error', true)
      ddSpan.setTag('error.type', AGENTS_ERROR_TYPE)
      if (rootSpan.error.message) {
        ddSpan.setTag('error.message', rootSpan.error.message)
      }
    }

    if (info) {
      if (!info.completionRequested) {
        info.completionRequested = true
        if (LLMObsTagger.tagMap.has(ddSpan)) {
          llmobsStorage.enterWith(info.llmobsParentStore)
        }
      }
      if (info.activeSpanCount > 0) return
    }

    this.#completeWorkflowSpan(traceId)
  }

  /**
   * Finish the workflow dd-trace span and clear its bookkeeping.
   *
   * @param {string} traceId
   */
  #completeWorkflowSpan (traceId) {
    const ddSpan = this.#oaiToDdSpan.get(traceId)
    if (!ddSpan) return

    if (this.#isLLMObsEnabled()) this.#setTraceAttributes(ddSpan, traceId)
    ddSpan.finish()
    this.#oaiToDdSpan.delete(traceId)
    this.#traceInfo.delete(traceId)
  }

  // ── Span lifecycle ──────────────────────────────────────────────────────────

  startSpan (oaiSpan, llmobsKind) {
    const spanId = oaiSpan.spanId
    if (!spanId || this.#oaiToDdSpan.has(spanId)) return

    const parentSpan = this.#resolveParent(oaiSpan)
    const spanName = deriveSpanName(oaiSpan)

    const ddSpan = this.#tracer.startSpan(spanName, {
      childOf: parentSpan,
      tags: this.#getSpanTags(KIND_TO_SPAN_KIND[llmobsKind] ?? 'internal'),
    })
    this.#oaiToDdSpan.set(spanId, ddSpan)
    this.#retainUntracedParent(oaiSpan.parentId)
    this.#spanStarted(oaiSpan.traceId)

    if (oaiSpan.spanData?.type === 'response' || oaiSpan.spanData?.type === 'generation') {
      const holder = this.#modelCallHolders.get(oaiSpan.parentId)
      if (holder) {
        holder.responseDdSpan = ddSpan
        this.reparentProviderSpans(holder)
        const store = llmobsStorage.getStore()
        if (store?.[MODEL_CALL_STORE_KEY] === holder) {
          llmobsStorage.enterWith({ ...store, span: ddSpan })
        }
      }
    }

    if (this.#isLLMObsEnabled()) {
      const llmobsOptions = {
        kind: llmobsKind,
        name: spanName,
        integration: COMPONENT,
        parent: parentSpan,
      }

      if (oaiSpan.spanData?.type === 'response' || oaiSpan.spanData?.type === 'generation') {
        // Model name only arrives with the response; tagged in
        // `#setResponseAttributes` once known. Model provider is resolved from
        // the agents-openai client's baseURL captured at getResponse time.
        llmobsOptions.modelProvider = this.#getCurrentModelProvider()
      }

      this.#tagger.registerLLMObsSpan(ddSpan, llmobsOptions)
      this.#updateTraceInfoInput(oaiSpan, spanName)
    }
  }

  endSpan (oaiSpan) {
    const spanId = oaiSpan.spanId
    const ddSpan = this.#oaiToDdSpan.get(spanId)
    if (!ddSpan) return

    try {
      applyError(ddSpan, oaiSpan)

      if (oaiSpan.spanData?.type === 'handoff') {
        const spanName = deriveSpanName(oaiSpan)
        ddSpan.setOperationName(spanName)
        if (this.#isLLMObsEnabled()) this.#tagger.setName(ddSpan, spanName)
      }

      if (this.#isLLMObsEnabled()) {
        const spanData = oaiSpan.spanData
        switch (spanData?.type) {
          case 'response':
            this.#setResponseAttributes(ddSpan, oaiSpan)
            this.#updateTraceInfoOutput(oaiSpan)
            break
          case 'generation':
            this.#setGenerationAttributes(ddSpan, oaiSpan)
            this.#updateTraceInfoOutput(oaiSpan)
            break
          case 'function':
            this.#tagger.tagTextIO(ddSpan, spanData.input ?? '', spanData.output ?? '')
            break
          case 'handoff':
            this.#tagger.tagTextIO(ddSpan, spanData.from_agent ?? '', spanData.to_agent ?? '')
            break
          case 'agent':
            this.#setAgentAttributes(ddSpan, oaiSpan)
            break
          case 'custom':
            if (spanData.data && typeof spanData.data === 'object') {
              this.#tagger.tagMetadata(ddSpan, spanData.data)
            }
            break
        }
      }

      if (oaiSpan.spanData?.type === 'response' || oaiSpan.spanData?.type === 'generation') {
        const holder = this.#modelCallHolders.get(oaiSpan.parentId)
        if (holder) this.reparentProviderSpans(holder)
      }

      // agents-core's withTrace skips Trace.end() when its callback throws, so
      // an errored top-level span is our last chance to finalize the workflow.
      if (oaiSpan.error && this.#isTopLevelSpan(oaiSpan)) {
        this.#requestWorkflowCompletion(oaiSpan.traceId, oaiSpan)
      }
    } finally {
      try {
        ddSpan.finish()
      } finally {
        this.#oaiToDdSpan.delete(spanId)
        if (oaiSpan.spanData?.type === 'response' || oaiSpan.spanData?.type === 'generation') {
          this.#modelCallHolders.delete(oaiSpan.parentId)
        }
        this.#releaseUntracedParent(oaiSpan.parentId)
        this.#spanEnded(oaiSpan.traceId)
      }
    }
  }

  // ── Per-type attribute setters ──────────────────────────────────────────────

  #setResponseAttributes (ddSpan, oaiSpan) {
    const response = oaiSpan.spanData?._response
    const input = oaiSpan.spanData?._input
    if (response?.model) {
      this.#tagger.tagModelName(ddSpan, response.model)
    }

    // Override the LLMObs span name to `{parent_agent_name} (LLM)` only when
    // the response is a direct child of the top-level agent (Python parity:
    // see `_llmobs_set_response_attributes` in dd-trace-py). For bare
    // `withResponseSpan` calls outside a `Runner.run()` flow the default
    // name (`openai_agents.response`) stays.
    const parentAgentName = this.#llmSpanParentAgentName(oaiSpan)
    if (parentAgentName) {
      this.#tagger.setName(ddSpan, `${parentAgentName} (LLM)`)
    }

    // Always tag LLM I/O so the LLMObs event shape is consistent across
    // happy/error paths. The extract* helpers emit placeholder messages
    // when their source is absent.
    const inputMessages = extractInputMessages(input, response?.instructions)
    this.#tagger.tagLLMIO(ddSpan, inputMessages, extractOutputMessages(response))

    // Cache messages for the workflow span's trace-level input (Python
    // parity: last message of the first response under the top-level agent).
    // Avoids re-running extractInputMessages in #setTraceAttributes.
    const info = this.#traceInfo.get(oaiSpan.traceId)
    if (info && info.inputOaiSpan === oaiSpan) {
      info.inputMessages = inputMessages
    }

    if (response) {
      const metrics = extractMetrics(response)
      if (metrics) this.#tagger.tagMetrics(ddSpan, metrics)

      const metadata = extractMetadata(response)
      if (metadata) this.#tagger.tagMetadata(ddSpan, metadata)
    }
  }

  /**
   * Tag a Chat Completions generation span from agents-core's public span data.
   *
   * @param {import('../../dd-trace/src/opentracing/span')} ddSpan
   * @param {object} oaiSpan
   */
  #setGenerationAttributes (ddSpan, oaiSpan) {
    const spanData = oaiSpan.spanData
    if (spanData?.model) {
      this.#tagger.tagModelName(ddSpan, spanData.model)
    }

    const parentAgentName = this.#llmSpanParentAgentName(oaiSpan)
    if (parentAgentName) {
      this.#tagger.setName(ddSpan, `${parentAgentName} (LLM)`)
    }

    const inputMessages = extractInputMessages(spanData?.input)
    this.#tagger.tagLLMIO(ddSpan, inputMessages, extractGenerationOutputMessages(spanData?.output))

    const info = this.#traceInfo.get(oaiSpan.traceId)
    if (info && info.inputOaiSpan === oaiSpan) {
      info.inputMessages = inputMessages
    }

    const metrics = extractMetrics({
      usage: spanData?.usage ?? spanData?.output?.at(-1)?.usage,
    })
    if (metrics) this.#tagger.tagMetrics(ddSpan, metrics)
    if (spanData?.model_config) this.#tagger.tagMetadata(ddSpan, spanData.model_config)
  }

  /**
   * If this response span's parent is the top-level agent span of the trace,
   * return that agent's dd-trace span name. Used to set the LLMObs span name
   * to `${agentName} (LLM)` (Python parity).
   *
   * @param {object} oaiSpan
   * @returns {string | undefined}
   */
  #llmSpanParentAgentName (oaiSpan) {
    const traceInfo = this.#traceInfo.get(oaiSpan.traceId)
    if (!traceInfo?.currentTopLevelAgentSpanId) return
    if (!this.#hasUntracedPathToAncestor(oaiSpan.parentId, traceInfo.currentTopLevelAgentSpanId)) return
    return traceInfo.currentTopLevelAgentName
  }

  #setAgentAttributes (ddSpan, oaiSpan) {
    const spanData = oaiSpan.spanData
    let metadata
    if (Array.isArray(spanData?.handoffs) && spanData.handoffs.length > 0) {
      metadata = { handoffs: spanData.handoffs }
    }
    if (Array.isArray(spanData?.tools) && spanData.tools.length > 0) {
      metadata ??= {}
      metadata.tools = spanData.tools
    }
    if (spanData?.output_type) {
      metadata ??= {}
      metadata.output_type = spanData.output_type
    }
    if (metadata) this.#tagger.tagMetadata(ddSpan, metadata)
  }

  #setTraceAttributes (ddSpan, traceId) {
    const info = this.#traceInfo.get(traceId)
    if (!info) return

    // Workflow-level input is the last input message of the first response
    // span under the top-level agent; output is `response.output_text` of
    // the last response span. Matches dd-trace-py's
    // `OaiSpanAdapter.llmobs_trace_input` / `response_output_text`. The
    // input messages were cached during #setResponseAttributes.
    const lastInputMessage = info.inputMessages?.at(-1)
    const inputValue = typeof lastInputMessage?.content === 'string' ? lastInputMessage.content : ''
    const outputSpanData = info.outputOaiSpan?.spanData
    let outputValue = getResponseOutputText(outputSpanData)
    if (outputSpanData?.type === 'generation') {
      const outputMessages = extractGenerationOutputMessages(outputSpanData.output)
      outputValue = outputMessages.at(-1)?.content ?? ''
    }

    this.#tagger.tagTextIO(ddSpan, inputValue, outputValue)

    // eslint-disable-next-line no-restricted-syntax -- agents-core builds metadata before the plugin receives it
    if (info.metadata && Object.keys(info.metadata).length > 0) {
      this.#tagger.tagMetadata(ddSpan, info.metadata)
    }
  }

  // ── Trace-info reconstruction (Python parity) ───────────────────────────────

  #updateTraceInfoInput (oaiSpan, spanName) {
    const info = this.#traceInfo.get(oaiSpan.traceId)
    if (!info) return

    const type = oaiSpan.spanData?.type

    // Identify the first top-level agent span under the root trace and
    // stash its display name so `${agentName} (LLM)` doesn't have to read
    // the dd-trace span context's private fields later.
    if (type === 'agent' && this.#isTopLevelSpan(oaiSpan)) {
      info.currentTopLevelAgentSpanId = oaiSpan.spanId
      info.currentTopLevelAgentName = spanName
    }

    // Capture the first response span whose parent is the top-level agent
    // as the workflow-level input source.
    if (
      (type === 'response' || type === 'generation') &&
      info.currentTopLevelAgentSpanId &&
      !info.inputOaiSpan &&
      this.#hasUntracedPathToAncestor(oaiSpan.parentId, info.currentTopLevelAgentSpanId)
    ) {
      info.inputOaiSpan = oaiSpan
    }
  }

  #updateTraceInfoOutput (oaiSpan) {
    const info = this.#traceInfo.get(oaiSpan.traceId)
    if (!info) return

    if (
      info.currentTopLevelAgentSpanId &&
      this.#hasUntracedPathToAncestor(oaiSpan.parentId, info.currentTopLevelAgentSpanId)
    ) {
      info.outputOaiSpan = oaiSpan
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  #resolveParent (oaiSpan) {
    return this.getDDSpan(oaiSpan.parentId) ?? this.#oaiToDdSpan.get(oaiSpan.traceId)
  }

  /**
   * Walk the agents-core parent chain from `spanId`, skipping spans we don't
   * trace, and return the first id that maps to a dd-trace span. Returns
   * `undefined` when the walk reaches the trace root (or a span we never saw),
   * which callers read as "no traced ancestor".
   *
   * @param {string | undefined | null} spanId agents-core spanId to start from
   * @returns {string | undefined}
   */
  #nearestTracedAncestorId (spanId) {
    let currentId = spanId
    for (let depth = 0; currentId != null && depth < MAX_ANCESTOR_WALK; depth++) {
      if (this.#oaiToDdSpan.has(currentId)) return currentId
      currentId = this.#untracedSpans.get(currentId)?.parentId
    }
  }

  /**
   * True when `spanId` reaches `ancestorId` through only untraced structural
   * spans. Unlike #nearestTracedAncestorId, this still recognizes an ancestor
   * whose dd-trace span has already finished and been removed from the live map.
   *
   * @param {string | undefined | null} spanId agents-core spanId to start from
   * @param {string} ancestorId agents-core ancestor spanId
   * @returns {boolean}
   */
  #hasUntracedPathToAncestor (spanId, ancestorId) {
    let currentId = spanId
    for (let depth = 0; currentId != null && depth < MAX_ANCESTOR_WALK; depth++) {
      if (currentId === ancestorId) return true
      currentId = this.#untracedSpans.get(currentId)?.parentId
    }
    return false
  }

  /**
   * True when nothing but untraced spans sits between this span and the trace
   * root. Stricter than `#nearestTracedAncestorId(…) === undefined`, which also
   * answers "undefined" for a parent we simply never saw — that must not be
   * mistaken for top-level, or an error would finalize the workflow span early.
   *
   * @param {object} oaiSpan
   * @returns {boolean}
   */
  #isTopLevelSpan (oaiSpan) {
    let currentId = oaiSpan.parentId
    for (let depth = 0; depth < MAX_ANCESTOR_WALK; depth++) {
      if (currentId == null) return true
      const info = this.#untracedSpans.get(currentId)
      if (!info) return false
      currentId = info.parentId
    }
    return false
  }

  /**
   * Keep a structural parent alive until this child callback completes.
   *
   * @param {string | undefined | null} parentId
   */
  #retainUntracedParent (parentId) {
    const info = this.#untracedSpans.get(parentId)
    if (info) info.activeChildCount++
  }

  /**
   * Release a structural parent and iteratively prune any ended, childless
   * ancestors. Each iteration deletes one node, so even a cyclic parent chain
   * terminates when it reaches the first node it already removed.
   *
   * @param {string | undefined | null} parentId
   */
  #releaseUntracedParent (parentId) {
    let currentId = parentId
    while (currentId != null) {
      const info = this.#untracedSpans.get(currentId)
      if (!info || info.activeChildCount === 0) return

      info.activeChildCount--
      if (!info.ended || info.activeChildCount > 0) return

      this.#untracedSpans.delete(currentId)
      currentId = info.parentId
    }
  }

  /**
   * Remove an ended structural span once no observed child still needs it.
   *
   * @param {string} spanId
   * @param {UntracedSpanInfo} info
   */
  #pruneUntracedSpan (spanId, info) {
    if (info.activeChildCount > 0) return
    this.#untracedSpans.delete(spanId)
    this.#releaseUntracedParent(info.parentId)
  }

  /**
   * Count a span callback whose end may arrive after trace completion.
   *
   * @param {string | undefined} traceId
   */
  #spanStarted (traceId) {
    const info = this.#traceInfo.get(traceId)
    if (info) info.activeSpanCount++
  }

  /**
   * Release one observed span callback and complete the trace when it becomes
   * quiescent. Structural ancestry prunes independently with each subtree.
   *
   * @param {string | undefined} traceId
   */
  #spanEnded (traceId) {
    const info = this.#traceInfo.get(traceId)
    if (!info) return
    if (info.activeSpanCount > 0) info.activeSpanCount--
    if (info.activeSpanCount > 0) return

    if (info.completionRequested) this.#completeWorkflowSpan(traceId)
  }

  /**
   * Read the mutable tracer configuration so remote/runtime enablement is
   * reflected without reconstructing the plugin.
   *
   * @returns {boolean}
   */
  #isLLMObsEnabled () {
    return this.#llmobsEnabled && !!this.#config.llmobs?.DD_LLMOBS_ENABLED
  }

  /**
   * Resolve model provider from the model invocation's async-local context.
   *
   * @returns {string}
   */
  #getCurrentModelProvider () {
    const baseURL = legacyStorage.getStore()?.[MODEL_BASE_URL_STORE_KEY]
    return baseURL ? getOpenAIModelProvider(baseURL) : DEFAULT_MODEL_PROVIDER
  }

  /**
   * Build common APM tags without overriding the tracer's global service when
   * the integration has no explicit service configuration.
   *
   * @param {string} spanKind
   * @returns {Record<string, string>}
   */
  #getSpanTags (spanKind) {
    const tags = {
      component: COMPONENT,
      'span.kind': spanKind,
    }
    if (this.#service) tags.service = this.#service
    return tags
  }
}

function getResponseOutputText (spanData) {
  const response = spanData?._response ?? spanData?.response
  if (typeof response?.output_text === 'string') return response.output_text
  if (typeof spanData?.output_text === 'string') return spanData.output_text
  const output = response?.output ?? spanData?.output
  if (!Array.isArray(output)) return ''

  let text = ''
  for (const item of output) {
    if (item?.type === 'message' && Array.isArray(item.content)) {
      for (const content of item.content) {
        if (content?.type === 'output_text') text += content.text ?? ''
      }
    } else if (item?.type === 'output_text') {
      text += item.text ?? ''
    }
  }
  return text
}

function buildAgentManifest (agent) {
  const manifest = { framework: 'OpenAI' }
  setDefined(manifest, 'name', agent.name)
  setDefined(manifest, 'instructions', typeof agent.instructions === 'string' ? agent.instructions : undefined)
  setDefined(manifest, 'handoff_description', agent.handoffDescription)

  const model = typeof agent.model === 'string' ? agent.model : agent.model?.model
  setDefined(manifest, 'model', model)

  const modelSettings = wireValue(agent.modelSettings)
  if (modelSettings) manifest.model_settings = modelSettings

  if (Array.isArray(agent.tools) && agent.tools.length > 0) {
    manifest.tools = agent.tools.map(buildToolManifest).filter(Boolean)
  }
  if (Array.isArray(agent.handoffs) && agent.handoffs.length > 0) {
    manifest.handoffs = agent.handoffs.map(buildHandoffManifest).filter(Boolean)
  }

  const guardrails = [
    ...(Array.isArray(agent.inputGuardrails) ? agent.inputGuardrails : []),
    ...(Array.isArray(agent.outputGuardrails) ? agent.outputGuardrails : []),
  ].map(guardrail => guardrail?.name).filter(Boolean)
  if (guardrails.length > 0) manifest.guardrails = guardrails

  return manifest
}

function buildToolManifest (tool) {
  if (!tool || typeof tool !== 'object') return
  const name = tool.name ?? tool.type
  if (!name) return

  if (tool.type === 'function' || tool.parameters || tool.params_json_schema) {
    const schema = tool.parameters ?? tool.params_json_schema
    const result = { name }
    setDefined(result, 'description', tool.description)
    setDefined(result, 'strict_json_schema', tool.strict ?? tool.strict_json_schema)
    if (schema?.properties && typeof schema.properties === 'object') {
      const parameters = {}
      for (const [propertyName, property] of Object.entries(schema.properties)) {
        if (!property || typeof property !== 'object') continue
        const parameter = {}
        setDefined(parameter, 'type', property.type)
        setDefined(parameter, 'title', property.title)
        parameter.required = schema.required?.includes(propertyName) ?? false
        parameters[propertyName] = parameter
      }
      result.parameters = parameters
    }
    return result
  }

  const result = { name }
  const providerData = tool.providerData
  if (providerData && typeof providerData === 'object') {
    for (const key of [
      'user_location',
      'search_context_size',
      'vector_store_ids',
      'max_num_results',
      'include_search_results',
      'ranking_options',
      'filters',
      'computer',
      'tool_config',
    ]) {
      setDefined(result, key, wireValue(providerData[key]))
    }
  }
  return result
}

function buildHandoffManifest (handoff) {
  if (!handoff || typeof handoff !== 'object') return
  const result = {}
  setDefined(result, 'handoff_description', handoff.handoffDescription ?? handoff.toolDescription)
  setDefined(result, 'agent_name', handoff.name ?? handoff.agentName)
  setDefined(result, 'tool_name', handoff.toolName)
  return result.handoff_description !== undefined ||
    result.agent_name !== undefined ||
    result.tool_name !== undefined
    ? result
    : undefined
}

function setDefined (target, key, value) {
  if (value !== undefined) target[key] = value
}

function wireValue (value, depth = 0, ancestors = [], budget) {
  budget ??= { remaining: MAX_MANIFEST_NODES }
  if (budget.remaining-- <= 0 || depth > MAX_MANIFEST_DEPTH) return
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined
  }
  if (!value || typeof value !== 'object' || ancestors.includes(value)) return
  const nextAncestors = [...ancestors, value]

  if (Array.isArray(value)) {
    const result = []
    for (const item of value) {
      const wired = wireValue(item, depth + 1, nextAncestors, budget)
      if (wired !== undefined) result.push(wired)
    }
    return result
  }

  const result = {}
  let hasValue = false
  for (const [key, item] of Object.entries(value)) {
    const wired = wireValue(item, depth + 1, nextAncestors, budget)
    if (wired !== undefined) {
      result[key] = wired
      hasValue = true
    }
  }
  return hasValue ? result : undefined
}

module.exports = { MODEL_BASE_URL_STORE_KEY, MODEL_CALL_STORE_KEY, OpenAIAgentsIntegration }
