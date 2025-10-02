'use strict'

const NoopAIGuard = require('./noop')
const executeRequest = require('./client')
const {
  AI_GUARD_RESOURCE,
  AI_GUARD_TARGET_TAG_KEY,
  AI_GUARD_REASON_TAG_KEY,
  AI_GUARD_ACTION_TAG_KEY,
  AI_GUARD_BLOCKED_TAG_KEY,
  AI_GUARD_META_STRUCT_KEY,
  AI_GUARD_TOOL_NAME_TAG_KEY
} = require('./tags')
const log = require('../log')

const ALLOW = 'ALLOW'

class AIGuardAbortError extends Error {
  constructor (reason) {
    super(reason)
    this.name = 'AIGuardAbortError'
    this.reason = reason
  }
}

class AIGuardClientError extends Error {
  constructor (message, opts = {}) {
    super(message)
    this.name = 'AIGuardClientError'
    if (opts.errors) {
      this.errors = opts.errors
    }
    if (opts.cause) {
      this.cause = opts.cause
    }
  }
}

class AIGuard extends NoopAIGuard {
  #initialized
  #tracer
  #headers
  #evaluateUrl
  #timeout
  #maxMessagesLength
  #maxContentSize
  #meta

  constructor (tracer, config) {
    super()

    if (!config.apiKey || !config.appKey) {
      log.error('AIGuard: missing api and/or app keys, use env DD_API_KEY and DD_APP_KEY')
      this.#initialized = false
      return
    }
    this.#tracer = tracer
    this.#headers = {
      'DD-API-KEY': config.apiKey,
      'DD-APPLICATION-KEY': config.appKey,
    }
    const endpoint = config.experimental.aiguard.endpoint || `https://app.${config.site}/api/v2/ai-guard`
    this.#evaluateUrl = `${endpoint}/evaluate`
    this.#timeout = config.experimental.aiguard.timeout
    this.#maxMessagesLength = config.experimental.aiguard.maxMessagesLength
    this.#maxContentSize = config.experimental.aiguard.maxContentSize
    this.#meta = { service: config.service, env: config.env }
    this.#initialized = true
  }

  #truncate (messages) {
    const size = Math.min(messages.length, this.#maxMessagesLength)
    const result = messages.slice(-size)

    for (let i = 0; i < size; i++) {
      const message = result[i]
      if (message.content?.length > this.#maxContentSize) {
        result[i] = { ...message, content: message.content.slice(0, this.#maxContentSize) }
      }
    }
    return result
  }

  #isToolCall (message) {
    return message.tool_calls || message.tool_call_id
  }

  #getToolName (message, history) {
    // 1. assistant message with tool calls
    if (message.tool_calls) {
      const names = message.tool_calls.map((tool) => tool.function.name)
      return names.length === 0 ? null : names.join(',')
    }
    // 2. assistant message with tool output (search the linked tool call in reverse order)
    const id = message.tool_call_id
    for (let i = history.length - 2; i >= 0; i--) {
      const item = history[i]
      if (item.tool_calls) {
        for (const toolCall of item.tool_calls) {
          if (toolCall.id === id) {
            return toolCall.function.name
          }
        }
      }
    }
    return null
  }

  evaluate (messages, opts) {
    if (!this.#initialized) {
      return super.evaluate(messages, opts)
    }
    const { block = false } = opts ?? {}
    return this.#tracer.trace(AI_GUARD_RESOURCE, {}, async (span) => {
      const last = messages[messages.length - 1]
      const target = this.#isToolCall(last) ? 'tool' : 'prompt'
      span.setTag(AI_GUARD_TARGET_TAG_KEY, target)
      if (target === 'tool') {
        const name = this.#getToolName(last, messages)
        if (name) {
          span.setTag(AI_GUARD_TOOL_NAME_TAG_KEY, name)
        }
      }
      span.meta_struct = {
        [AI_GUARD_META_STRUCT_KEY]: {
          messages: this.#truncate(messages)
        }
      }
      let response
      try {
        const payload = {
          data: {
            attributes: {
              messages,
              meta: this.#meta,
            }
          }
        }
        response = await executeRequest(
          payload,
          { url: this.#evaluateUrl, headers: this.#headers, timeout: this.#timeout })
      } catch (e) {
        throw new AIGuardClientError('Unexpected error calling AI Guard service', { cause: e })
      }
      if (response.status !== 200) {
        throw new AIGuardClientError(
          `AI Guard service call failed, status ${response.status}`,
          { errors: response.body?.errors })
      }
      let action, reason, blockingEnabled
      try {
        const attr = response.body.data.attributes
        if (!attr.action) {
          throw new Error('Action missing from response')
        }
        action = attr.action
        reason = attr.reason
        blockingEnabled = attr.is_blocking_enabled ?? false
      } catch (e) {
        throw new AIGuardClientError(`AI Guard service returned unexpected response : ${response.body}`, { cause: e })
      }
      span.setTag(AI_GUARD_ACTION_TAG_KEY, action)
      span.setTag(AI_GUARD_REASON_TAG_KEY, reason)
      if (block && blockingEnabled && action !== ALLOW) {
        span.setTag(AI_GUARD_BLOCKED_TAG_KEY, 'true')
        throw new AIGuardAbortError(reason)
      }
      return { action, reason }
    })
  }
}

module.exports = AIGuard
