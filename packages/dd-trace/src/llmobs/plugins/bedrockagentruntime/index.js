'use strict'

const log = require('../../../log')
const { storage: llmobsStorage } = require('../../storage')
const telemetry = require('../../telemetry')
const BaseLLMObsPlugin = require('../base')
const { translateBedrockTraces } = require('./trace-translation')

const decoder = new TextDecoder()

class BedrockAgentRuntimeLLMObsPlugin extends BaseLLMObsPlugin {
  static integration = 'bedrock_agents'

  #onStart (ctx) {
    if (!this._tracerConfig.llmobs.DD_LLMOBS_ENABLED) return
    if (ctx.operation !== 'invokeAgent') return
    ctx.bedrockAgent = {
      parent: llmobsStorage.getStore()?.span,
      chunks: [],
      traces: [],
    }
  }

  constructor (...args) {
    super(...args)

    this.addSub('apm:aws:request:start:bedrockagentruntime', ctx => this.#onStart(ctx))

    this.addSub('apm:aws:response:streamed-chunk:bedrockagentruntime', ({ ctx, chunk }) => {
      if (ctx.request.operation !== 'invokeAgent' || !ctx.bedrockAgent) return
      if (chunk?.chunk?.bytes) {
        ctx.bedrockAgent.chunks.push(decoder.decode(chunk.chunk.bytes))
      } else if (chunk?.trace) {
        ctx.bedrockAgent.traces.push(chunk.trace)
      }
    })

    this.addSub('apm:aws:request:complete:bedrockagentruntime', ctx => {
      if (ctx.request.operation !== 'invokeAgent' || !ctx.bedrockAgent) return

      try {
        if (!this._tracerConfig.llmobs.DD_LLMOBS_ENABLED) return
        const span = ctx.currentStore?.span
        const params = ctx.request.params || {}
        if (!span) return

        const outputText = ctx.bedrockAgent.chunks.join('')
        telemetry.incrementLLMObsSpanStartCount({ autoinstrumented: true, integration: 'bedrock_agents' })
        this._tagger.registerLLMObsSpan(span, {
          parent: ctx.bedrockAgent.parent,
          kind: 'agent',
          name: `Bedrock Agent ${params.agentId ?? ''}`,
          sessionId: params.sessionId,
          integration: 'bedrock_agents',
        })
        this._tagger.tagMetadata(span, {
          agent_id: params.agentId ?? '',
          agent_alias_id: params.agentAliasId ?? '',
        })
        if (!ctx.response?.error && outputText) {
          this._tagger.tagTextIO(span, String(params.inputText ?? ''), outputText)
        } else {
          this._tagger.tagTextIO(span, String(params.inputText ?? ''))
        }
        translateBedrockTraces({
          tracer: this.tracer,
          tagger: this._tagger,
          rootSpan: span,
          traces: ctx.bedrockAgent.traces,
        })
      } catch (error) {
        log.warn('Error translating Bedrock Agent traces: %s', error.message)
        log.debug(error)
      }
    })
  }
}

module.exports = BedrockAgentRuntimeLLMObsPlugin
