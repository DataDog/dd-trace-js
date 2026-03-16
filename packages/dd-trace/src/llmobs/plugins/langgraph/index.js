'use strict'

const LLMObsPlugin = require('../base')
const { spanHasError } = require('../../util')

const streamDataMap = new WeakMap()

function formatIO (data) {
  if (data == null) return ''

  if (typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean') {
    return data
  }

  if (data.constructor?.name === 'Object') {
    const formatted = {}
    for (const [key, value] of Object.entries(data)) {
      formatted[key] = formatIO(value)
    }
    return formatted
  }

  if (Array.isArray(data)) {
    return data.map(item => formatIO(item))
  }

  try {
    return JSON.stringify(data)
  } catch {
    return String(data)
  }
}

class PregelStreamLLMObsPlugin extends LLMObsPlugin {
  static id = 'llmobs_langgraph_pregel_stream'
  static integration = 'langgraph'
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_stream'

  getLLMObsSpanRegisterOptions (ctx) {
    const name = ctx.self.name || 'LangGraph'

    const enabled = this._tracerConfig.llmobs.enabled
    if (!enabled) return

    const span = ctx.currentStore?.span
    if (!span) return
    streamDataMap.set(span, {
      streamInputs: ctx.arguments?.[0],
      chunks: [],
    })

    return {
      kind: 'workflow',
      name,
    }
  }

  asyncEnd () {}
}

class NextStreamLLMObsPlugin extends LLMObsPlugin {
  static id = 'llmobs_langgraph_next_stream'
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_stream_next'

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

    const { streamInputs: inputs, chunks } = streamData
    const input = inputs == null ? undefined : formatIO(inputs)
    const lastChunk = chunks.length > 0 ? chunks[chunks.length - 1] : undefined
    const output = !hasError && lastChunk != null ? formatIO(lastChunk) : undefined

    this._tagger.tagTextIO(span, input, output)

    streamDataMap.delete(span)
  }
}

module.exports = [
  PregelStreamLLMObsPlugin,
  NextStreamLLMObsPlugin,
]
