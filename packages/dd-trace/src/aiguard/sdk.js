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
const { URL } = require('url')

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
  constructor (tracer, config) {
    super(tracer)

    if (!config.apiKey || !config.appKey) {
      const message = 'AIGuard: missing api and/or app keys, use env DD_API_KEY and DD_APP_KEY'
      log.error(message)
      throw new Error(message)
    }
    this._headers = {
      'DD-API-KEY': config.apiKey,
      'DD-APPLICATION-KEY': config.appKey,
    }

    if (config.protocolVersion !== '0.4') {
      log.error('AIGuard: observability of evaluation results requires protocol version 0.4')
    }

    let endpoint = config.aiguard?.endpoint
    if (!endpoint) {
      endpoint = `https://app.${config.site}/api/v2/ai-guard`
    }
    this._evaluateUrl = new URL(`${endpoint}/evaluate`)

    this._timeout = config.aiguard.timeout
    this._maxMessagesLength = config.experimental.aiguard.maxMessagesLength
    this._maxContentSize = config.experimental.aiguard.maxContentSize
    this._meta = { service: config.service, env: config.env }
  }

  _truncate (messages) {
    const size = Math.min(messages.length, this._maxMessagesLength)
    const result = new Array(size)
    for (let i = 0; i < size; i++) {
      let message = messages[i]
      if ('content' in message && message.content.length > this._maxContentSize) {
        message = { ...message }
        message.content = message.content.slice(0, this._maxContentSize)
      }
      result[i] = message
    }
    return result
  }

  _isToolCall (message) {
    return 'tool_calls' in message || 'tool_call_id' in message
  }

  _getToolName (message, history) {
    // 1. assistant message with tool calls
    if ('tool_calls' in message) {
      const names = message.tool_calls.map((tool) => tool.function.name)
      return names.length === 0 ? null : names.join(',')
    }
    // 2. assistant message with tool output (search the linked tool call in reverse order)
    const id = message.tool_call_id
    for (let i = history.length - 2; i >= 0; i--) {
      const item = history[i]
      if ('tool_calls' in item) {
        for (const toolCall of item.tool_calls) {
          if (toolCall.id === id) {
            return toolCall.function.name
          }
        }
      }
    }
    return null
  }

  async evaluate (messages, opts) {
    const { block = false } = opts ?? {}
    return await this._tracer.trace(AI_GUARD_RESOURCE, {}, async (span) => {
      const last = messages[messages.length - 1]
      const target = this._isToolCall(last) ? 'tool' : 'prompt'
      span.setTag(AI_GUARD_TARGET_TAG_KEY, target)
      if (target === 'tool') {
        const name = this._getToolName(last, messages)
        if (name) {
          span.setTag(AI_GUARD_TOOL_NAME_TAG_KEY, name)
        }
      }
      span.meta_struct = {
        [AI_GUARD_META_STRUCT_KEY]: {
          messages: this._truncate(messages)
        }
      }
      let response
      try {
        const payload = {
          data: {
            attributes: {
              messages,
              meta: this._meta,
            }
          }
        }
        response = await executeRequest(
          payload,
          { url: this._evaluateUrl, headers: this._headers, timeout: this._timeout })
      } catch (e) {
        log.debug('AI Guard API call failed', e)
        throw new AIGuardClientError('Unexpected error calling AI Guard service', { cause: e })
      }
      if (response.status !== 200) {
        log.debug(`AI Guard API call failed: ${JSON.stringify(response)}`)
        throw new AIGuardClientError(
          `AI Guard service call failed, status ${response.status}`,
          { errors: response.body?.errors })
      }
      let action, reason, blockingEnabled
      try {
        const attr = response.body.data.attributes
        if (!('action' in attr)) {
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
