'use strict'

const LLMObsPlugin = require('../base')
const { spanHasError } = require('../../util')

const streamDataMap = new WeakMap()

class BaseLangGraphLLMObsPlugin extends LLMObsPlugin {
  static integration = 'langgraph'
  static id = 'langgraph'

  getLLMObsSpanRegisterOptions (ctx) {
    const span = ctx.currentStore?.span
    const name = span?.context()._tags?.['resource.name'] || 'langgraph.workflow'

    return {
      kind: 'workflow',
      name,
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const inputs = ctx.arguments?.[0]
    const results = ctx.result
    const hasError = ctx.error || spanHasError(span)

    const input = inputs !== undefined && inputs !== null ? this.formatIO(inputs) : undefined
    const output = hasError
      ? undefined
      : (results !== undefined && results !== null ? this.formatIO(results) : undefined)

    this._tagger.tagTextIO(span, input, output)
  }

  formatIO (data) {
    if (data === null || data === undefined) return ''

    if (typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean') {
      return data
    }

    if (data.constructor?.name === 'Object') {
      const formatted = {}
      for (const [key, value] of Object.entries(data)) {
        formatted[key] = this.formatIO(value)
      }
      return formatted
    }

    if (Array.isArray(data)) {
      return data.map(item => this.formatIO(item))
    }

    try {
      return JSON.stringify(data)
    } catch {
      return String(data)
    }
  }
}

class PregelStreamLLMObsPlugin extends BaseLangGraphLLMObsPlugin {
  static id = 'llmobs_langgraph_pregel_stream'
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_stream'

  asyncEnd (ctx) {
    const enabled = this._tracerConfig.llmobs.enabled
    if (!enabled) return

    const span = ctx.currentStore?.span
    if (!span) return

    streamDataMap.set(span, {
      streamInputs: ctx.arguments?.[0],
      streamResult: ctx.result,
    })
  }
}

class NextStreamLLMObsPlugin extends BaseLangGraphLLMObsPlugin {
  static id = 'llmobs_langgraph_next_stream'
  static prefix = 'tracing:orchestrion:@langchain/langgraph:Pregel_stream_next'

  start () {
    // Don't register a new span - the span was already registered by PregelStreamLLMObsPlugin
    // We just need to tag it when iteration completes
  }

  end () {
    // Don't restore context - that will be handled by PregelStreamLLMObsPlugin
  }

  asyncStart (ctx) {
    if (!ctx.result?.done) return
    this.#tagOnComplete(ctx)
  }

  asyncEnd (ctx) {
    if (!ctx.result?.done) return
    this.#tagOnComplete(ctx)
  }

  error (ctx) {
    this.#tagOnComplete(ctx)
  }

  #tagOnComplete (ctx) {
    const enabled = this._tracerConfig.llmobs.enabled
    if (!enabled) return

    const span = ctx.currentStore?.span
    if (!span) return

    // Get the stored input from when stream() was called
    const streamData = streamDataMap.get(span)
    if (!streamData) return

    const inputs = streamData.streamInputs
    const results = streamData.streamResult
    const hasError = ctx.error || spanHasError(span)

    const input = inputs !== undefined && inputs !== null ? this.formatIO(inputs) : undefined
    // For streaming, only tag output if there's no error
    // ctx.result is the iterator result, and results is the iterator object
    const output = hasError
      ? undefined
      : (results !== undefined && results !== null ? this.formatIO(results) : undefined)

    this._tagger.tagTextIO(span, input, output)

    // Clean up
    streamDataMap.delete(span)
  }
}

module.exports = [
  PregelStreamLLMObsPlugin,
  NextStreamLLMObsPlugin,
]
