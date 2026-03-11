'use strict'

const log = require('../../dd-trace/src/log')
const Plugin = require('../../dd-trace/src/plugins/plugin')
const { convertToAIGuardFormat, convertToolCallPart } = require('../../dd-trace/src/aiguard/convert')

const PROMPT_BLOCKED_ERROR_MESSAGE = 'Prompt blocked by AI Guard security policy'
const TOOL_CALL_BLOCKED_ERROR_MESSAGE = 'Tool call blocked by AI Guard security policy'

class VercelAIGuardPlugin extends Plugin {
  static id = 'ai'

  constructor (...args) {
    super(...args)

    this.addSub('dd-trace:vercel-ai:aiguard:prompt', this.onPrompt)
    this.addSub('dd-trace:vercel-ai:aiguard:tool-call', this.onToolCall)
  }

  /**
   * @override
   * @param {boolean|object} config
   */
  configure (config) {
    if (!config?.experimental?.aiguard?.enabled) {
      return super.configure(false)
    }

    return super.configure(config)
  }

  /**
   * @param {{
   *   params?: { prompt?: Array<object> },
   *   fnName?: string,
   *   baseMessages?: Array<object>,
   *   blockPromise?: Promise<void>,
   *   skipToolCallEvaluation?: boolean
   * }} ctx
   * @returns {void}
   */
  onPrompt (ctx) {
    const prompt = ctx.params?.prompt
    if (!Array.isArray(prompt) || prompt.length === 0) {
      return
    }

    const aiguard = this._tracer?.aiguard ?? this.tracer.aiguard
    if (!aiguard) {
      return
    }

    let baseMessages

    try {
      baseMessages = convertToAIGuardFormat(prompt)
    } catch (error) {
      ctx.skipToolCallEvaluation = true
      log.error('[AI Guard] Failed to convert prompt for %s: %s', ctx.fnName, error?.message ?? error)
      return
    }

    ctx.baseMessages = baseMessages

    if (baseMessages.length === 0) {
      return
    }

    ctx.blockPromise = evaluateWithAIGuard(aiguard, baseMessages, PROMPT_BLOCKED_ERROR_MESSAGE)
  }

  /**
   * @param {{ toolCall?: object, fnName?: string, baseMessages?: Array<object>, blockPromise?: Promise<void> }} ctx
   * @returns {void}
   */
  onToolCall (ctx) {
    const aiguard = this._tracer?.aiguard ?? this.tracer.aiguard
    if (!aiguard || ctx.toolCall == null) {
      return
    }

    let normalizedToolCall

    try {
      normalizedToolCall = convertToolCallPart(ctx.toolCall)
    } catch (error) {
      log.error('[AI Guard] Failed to normalize tool call for %s: %s', ctx.fnName, error?.message ?? error)
      return
    }

    const baseMessages = Array.isArray(ctx.baseMessages) ? ctx.baseMessages : []
    const messages = [...baseMessages, {
      role: 'assistant',
      content: '',
      tool_calls: [normalizedToolCall],
    }]

    ctx.blockPromise = evaluateWithAIGuard(aiguard, messages, TOOL_CALL_BLOCKED_ERROR_MESSAGE)
  }
}

/**
 * @param {{ evaluate: Function }} aiguard
 * @param {Array<object>} messages
 * @param {string} blockedMessage
 * @returns {Promise<void>}
 */
function evaluateWithAIGuard (aiguard, messages, blockedMessage) {
  return Promise.resolve()
    .then(() => aiguard.evaluate(messages, { block: true }))
    .then(
      () => {},
      error => handleEvaluationError(error, blockedMessage)
    )
}

/**
 * @param {unknown} error
 * @param {string} blockedMessage
 * @returns {undefined}
 */
function handleEvaluationError (error, blockedMessage) {
  if (error?.name === 'AIGuardAbortError') {
    throw new Error(blockedMessage)
  }

  log.error('[AI Guard] Evaluation failed: %s', error?.message ?? error)
}

module.exports = VercelAIGuardPlugin
