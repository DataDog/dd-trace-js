'use strict'

const LLMObsPlugin = require('../base')
const { formatIO } = require('../langchain/messages')
const { spanHasError } = require('../../util')

const streamDataMap = new WeakMap()

const DEFAULT_RECURSION_LIMIT = 25

/**
 * @typedef {{ name: string, description: string, parameters: Record<string, unknown> }} AgentManifestTool
 * @typedef {{
 *   name: string,
 *   framework: string,
 *   tools: AgentManifestTool[],
 *   max_iterations: number,
 *   dependencies?: string[]
 * }} AgentManifest
 */

/**
 * Tool schemas are usually Zod instances, which are not serializable; only plain JSON schemas are reported.
 *
 * @param {unknown} schema
 * @returns {schema is Record<string, unknown>}
 */
function isJsonSchema (schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false
  const { type, properties } = /** @type {Record<string, unknown>} */ (schema)
  return typeof type === 'string' || (properties != null && typeof properties === 'object')
}

/**
 * Collects the tools registered on the graph's `ToolNode`s.
 *
 * @param {{ builder?: { nodes?: Record<string, { runnable?: { tools?: unknown[] } }> } }} graph
 * @returns {AgentManifestTool[]}
 */
function getToolsFromGraph (graph) {
  const tools = []
  const nodes = graph.builder?.nodes
  if (!nodes || typeof nodes !== 'object') return tools

  for (const node of Object.values(nodes)) {
    const nodeTools = node?.runnable?.tools
    if (!Array.isArray(nodeTools)) continue

    for (const tool of nodeTools) {
      if (!tool || typeof tool !== 'object') continue
      const { name, description, schema } = /** @type {Record<string, unknown>} */ (tool)
      tools.push({
        name: typeof name === 'string' ? name : '',
        description: typeof description === 'string' ? description : '',
        parameters: isJsonSchema(schema) ? schema : {},
      })
    }
  }

  return tools
}

/**
 * Builds the `_dd.agent_manifest` metadata that dd-trace-py attaches to LangGraph agent spans.
 *
 * @param {{ name?: string, builder?: object }} graph
 * @param {string} name
 * @param {unknown} input
 * @param {{ recursionLimit?: number } | undefined} config
 * @returns {AgentManifest}
 */
function getAgentManifest (graph, name, input, config) {
  /** @type {AgentManifest} */
  const manifest = {
    name,
    tools: getToolsFromGraph(graph),
    framework: 'LangGraph',
    max_iterations: typeof config?.recursionLimit === 'number' ? config.recursionLimit : DEFAULT_RECURSION_LIMIT,
  }

  if (input && typeof input === 'object' && !Array.isArray(input)) {
    manifest.dependencies = Object.keys(input)
  }

  return manifest
}

class PregelStreamLLMObsPlugin extends LLMObsPlugin {
  static id = 'llmobs_langgraph_pregel_stream'
  static integration = 'langgraph'
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_stream'

  getLLMObsSpanRegisterOptions (ctx) {
    const name = ctx.self.name || 'LangGraph'

    const enabled = this._tracerConfig.llmobs.DD_LLMOBS_ENABLED
    if (!enabled) return

    const span = ctx.currentStore?.span
    if (!span) return
    const streamInputs = ctx.arguments?.[0]
    streamDataMap.set(span, {
      streamInputs,
      chunks: [],
      agentManifest: getAgentManifest(ctx.self, name, streamInputs, ctx.arguments?.[1]),
    })

    return {
      kind: 'agent',
      name,
    }
  }

  asyncEnd () {}
}

class NextStreamLLMObsPlugin extends LLMObsPlugin {
  static id = 'llmobs_langgraph_next_stream'
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_stream:next'

  start () {} // no-op: span was already registered by PregelStreamLLMObsPlugin

  end () {} // no-op: context restore is handled by PregelStreamLLMObsPlugin

  error (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    this.#tagAndCleanup(span, true)
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    // Accumulate chunks until done
    if (ctx.result?.value && !ctx.result.done) {
      const streamData = streamDataMap.get(span)
      if (streamData) {
        streamData.chunks.push(ctx.result.value)
      }
      return
    }

    // Tag on last chunk
    if (ctx.result?.done) {
      const hasError = ctx.error || spanHasError(span)
      this.#tagAndCleanup(span, hasError)
    }
  }

  #tagAndCleanup (span, hasError) {
    const streamData = streamDataMap.get(span)
    if (!streamData) return

    const { streamInputs: inputs, chunks, agentManifest } = streamData
    this._tagger.tagMetadata(span, { _dd: { agent_manifest: agentManifest } })
    const input = inputs == null ? undefined : formatIO(inputs)
    const lastChunk = chunks.length > 0 ? chunks.at(-1) : undefined
    const output = !hasError && lastChunk != null ? formatIO(lastChunk) : undefined

    this._tagger.tagTextIO(span, input, output)

    streamDataMap.delete(span)
  }
}

module.exports = [
  PregelStreamLLMObsPlugin,
  NextStreamLLMObsPlugin,
]
