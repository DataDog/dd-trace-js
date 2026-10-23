'use strict'

const LLMObsPlugin = require('../base')
const { storage: llmobsStorage } = require('../../storage')
const { formatInputMessages } = require('../genai/util')
const { extractModelInfo } = require('./util')

const runnerDataMap = new WeakMap()

function createRunnerPlugin (id, prefix) {
  return class RunnerLLMObsPlugin extends LLMObsPlugin {
    static id = id
    static integration = 'google_adk'
    static prefix = prefix

    getLLMObsSpanRegisterOptions (ctx) {
      const span = ctx.currentStore?.span
      if (!span) return

      const params = ctx.arguments?.[0]
      const agent = ctx.self?.agent
      const { modelName, modelProvider } = extractModelInfo(agent?.model)
      runnerDataMap.set(span, {
        params,
        agent,
        appName: ctx.self?.appName,
        events: [],
      })

      return {
        kind: 'agent',
        name: agent?.name || 'Google ADK Agent',
        modelName,
        modelProvider,
        sessionId: params?.sessionId,
      }
    }

    asyncEnd () {}
  }
}

function createRunnerNextPlugin (id, prefix) {
  return class RunnerNextLLMObsPlugin extends LLMObsPlugin {
    static id = id
    static integration = 'google_adk'
    static prefix = prefix

    start (ctx) {
      ctx.llmobsNextParent = llmobsStorage.getStore()
      const span = ctx.currentStore?.span
      if (span) llmobsStorage.enterWith({ ...ctx.llmobsNextParent, span })
    }

    end (ctx) {
      llmobsStorage.enterWith(ctx.llmobsNextParent)
    }

    error (ctx) {
      super.error(ctx)
      this.#tagAndCleanup(ctx, true)
    }

    setLLMObsTags (ctx) {
      const span = ctx.currentStore?.span
      const data = span && runnerDataMap.get(span)
      if (!data) return

      if (ctx.method === 'next' && ctx.result?.value && !ctx.result.done) {
        if (ctx.result.value.errorCode || ctx.result.value.errorMessage) {
          this.addError(new Error(ctx.result.value.errorMessage), span)
          this.#tagAndCleanup(ctx, true)
          return
        }
        data.events.push(ctx.result.value)
        return
      }

      if (ctx.result?.done) this.#tagAndCleanup(ctx, false)
    }

    #tagAndCleanup (ctx, hasError) {
      const span = ctx.currentStore?.span
      const data = span && runnerDataMap.get(span)
      if (!data) return

      const { params, agent, appName, events } = data
      const input = params?.newMessage
        ? formatInputMessages([params.newMessage])[0]?.content
        : undefined
      const output = hasError
        ? undefined
        : formatInputMessages(events.map(event => event.content).filter(Boolean))

      this._tagger.tagTextIO(span, input, output)

      const tags = {}
      if (params?.userId !== undefined) tags.user_id = params.userId
      if (appName !== undefined) tags.app_name = appName
      this._tagger.tagSpanTags(span, tags)

      if (agent) {
        const { modelName } = extractModelInfo(agent.model)
        this._tagger.tagMetadata(span, {
          agent_manifest: {
            framework: 'Google ADK',
            name: agent.name,
            model: modelName,
            description: agent.description ?? '',
            instructions: typeof agent.instruction === 'string' ? agent.instruction : '',
            model_configuration: agent.generateContentConfig,
            session_management: {
              session_id: params?.sessionId,
              user_id: params?.userId,
              app_name: appName,
            },
            tools: (agent.tools ?? []).map(tool => typeof tool === 'function'
              ? { name: tool.name, description: '' }
              : { name: tool.name ?? 'Agent Tool', description: tool.description ?? '' }),
          },
        })
      }

      runnerDataMap.delete(span)
    }
  }
}

class ToolLLMObsPlugin extends LLMObsPlugin {
  static id = 'llmobs_google_adk_tool'
  static integration = 'google_adk'
  static prefix = 'tracing:orchestrion:@google/adk:callToolAsync'

  getLLMObsSpanRegisterOptions (ctx) {
    const [tool, , toolContext] = ctx.arguments || []
    const { modelName, modelProvider } = extractModelInfo(toolContext?.invocationContext?.agent?.model)
    return { kind: 'tool', name: tool?.name, modelName, modelProvider }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const [tool, args] = ctx.arguments || []
    this._tagger.tagTextIO(span, args, ctx.error ? undefined : ctx.result)
    this._tagger.tagMetadata(span, { description: tool?.description ?? '' })
  }
}

class CodeExecuteLLMObsPlugin extends LLMObsPlugin {
  static id = 'llmobs_google_adk_code_execute'
  static integration = 'google_adk'
  static prefix = 'tracing:orchestrion:@google/adk:executeCode'

  getLLMObsSpanRegisterOptions (ctx) {
    const params = ctx.arguments?.[0]
    const { modelName, modelProvider } = extractModelInfo(params?.invocationContext?.agent?.model)
    return {
      kind: 'tool',
      name: 'Google ADK Code Execute',
      modelName,
      modelProvider,
    }
  }

  setLLMObsTags (ctx) {
    const span = ctx.currentStore?.span
    if (!span) return

    const params = ctx.arguments?.[0]
    const input = params?.codeExecutionInput?.code
    const output = ctx.error
      ? undefined
      : `${ctx.result?.stdout || ''}${ctx.result?.stderr ? `\n${ctx.result.stderr}` : ''}`
    this._tagger.tagTextIO(span, input, output)
  }
}

module.exports = [
  createRunnerPlugin(
    'llmobs_google_adk_runner_run_async',
    'tracing:orchestrion:@google/adk:Runner_runAsync'
  ),
  createRunnerNextPlugin(
    'llmobs_google_adk_runner_run_async_next',
    'tracing:orchestrion:@google/adk:Runner_runAsync:next'
  ),
  createRunnerPlugin(
    'llmobs_google_adk_runner_run_live',
    'tracing:orchestrion:@google/adk:Runner_runLive'
  ),
  createRunnerNextPlugin(
    'llmobs_google_adk_runner_run_live_next',
    'tracing:orchestrion:@google/adk:Runner_runLive:next'
  ),
  ToolLLMObsPlugin,
  CodeExecuteLLMObsPlugin,
]
